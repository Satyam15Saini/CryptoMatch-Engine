from fastapi import FastAPI, APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import asyncio
import json
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Dict, Optional, Literal
import uuid
from datetime import datetime, timezone
from sortedcontainers import SortedDict
from collections import deque
from decimal import Decimal

# Load environment variables
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ.get('DB_NAME', 'matching_engine')]

app = FastAPI(title="CryptoMatch Engine API")
api_router = APIRouter(prefix="/api")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============== MODELS ==============

class OrderSubmission(BaseModel):
    symbol: str
    order_type: Literal["market", "limit", "ioc", "fok"]
    side: Literal["buy", "sell"]
    quantity: float
    price: Optional[float] = None

class Order(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    order_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    symbol: str
    order_type: str
    side: str
    quantity: float
    price: Optional[float] = None
    remaining_quantity: float
    status: str = "open"  # open, partially_filled, filled, cancelled
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class Trade(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    trade_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    symbol: str
    price: float
    quantity: float
    aggressor_side: str
    maker_order_id: str
    taker_order_id: str

class BBO(BaseModel):
    symbol: str
    best_bid: Optional[float] = None
    best_bid_quantity: Optional[float] = None
    best_ask: Optional[float] = None
    best_ask_quantity: Optional[float] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class OrderBookSnapshot(BaseModel):
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    symbol: str
    bids: List[List[float]]  # [[price, quantity], ...]
    asks: List[List[float]]  # [[price, quantity], ...]

# ============== MATCHING ENGINE ==============

class MatchingEngine:
    def __init__(self):
        # Order books for each symbol: symbol -> {"bids": SortedDict, "asks": SortedDict}
        self.order_books: Dict[str, Dict] = {}
        # Active orders: order_id -> Order
        self.active_orders: Dict[str, Order] = {}
        # WebSocket connections
        self.orderbook_connections: List[WebSocket] = []
        self.trade_connections: List[WebSocket] = []
        self.bbo_connections: List[WebSocket] = []
        self.lock = asyncio.Lock()
    
    def ensure_order_book(self, symbol: str):
        """Initialize order book for symbol if it doesn't exist"""
        if symbol not in self.order_books:
            self.order_books[symbol] = {
                "bids": SortedDict(),  # price -> deque of orders (descending)
                "asks": SortedDict()   # price -> deque of orders (ascending)
            }
    
    def add_order_to_book(self, order: Order):
        """Add order to the order book"""
        self.ensure_order_book(order.symbol)
        book = self.order_books[order.symbol]
        
        if order.side == "buy":
            price = -order.price  # Negate for descending order
            if price not in book["bids"]:
                book["bids"][price] = deque()
            book["bids"][price].append(order)
        else:  # sell
            price = order.price
            if price not in book["asks"]:
                book["asks"][price] = deque()
            book["asks"][price].append(order)
        
        self.active_orders[order.order_id] = order
    
    def remove_order_from_book(self, order: Order):
        """Remove order from the order book"""
        book = self.order_books[order.symbol]
        
        if order.side == "buy":
            if -order.price in book["bids"]:
                try:
                    book["bids"][-order.price].remove(order)
                    if not book["bids"][-order.price]:
                        del book["bids"][-order.price]
                except ValueError:
                    pass
        else:  # sell
            if order.price in book["asks"]:
                try:
                    book["asks"][order.price].remove(order)
                    if not book["asks"][order.price]:
                        del book["asks"][order.price]
                except ValueError:
                    pass
        
        if order.order_id in self.active_orders:
            del self.active_orders[order.order_id]
    
    def get_bbo(self, symbol: str) -> BBO:
        """Calculate and return Best Bid and Offer"""
        self.ensure_order_book(symbol)
        book = self.order_books[symbol]
        bbo = BBO(symbol=symbol)
        
        # Best bid (highest price)
        if book["bids"]:
            best_bid_price = -book["bids"].keys()[0]  # First key (most negative = highest positive)
            best_bid_quantity = sum(o.remaining_quantity for o in book["bids"][-best_bid_price])
            bbo.best_bid = best_bid_price
            bbo.best_bid_quantity = best_bid_quantity
        
        # Best ask (lowest price)
        if book["asks"]:
            best_ask_price = book["asks"].keys()[0]  # First key (lowest)
            best_ask_quantity = sum(o.remaining_quantity for o in book["asks"][best_ask_price])
            bbo.best_ask = best_ask_price
            bbo.best_ask_quantity = best_ask_quantity
        
        return bbo
    
    def get_order_book_snapshot(self, symbol: str, depth: int = 10) -> OrderBookSnapshot:
        """Get order book snapshot with specified depth"""
        self.ensure_order_book(symbol)
        book = self.order_books[symbol]
        
        # Get top N bids (highest prices)
        bids = []
        for price in list(book["bids"].keys())[:depth]:
            total_quantity = sum(o.remaining_quantity for o in book["bids"][price])
            bids.append([float(-price), float(total_quantity)])
        
        # Get top N asks (lowest prices)
        asks = []
        for price in list(book["asks"].keys())[:depth]:
            total_quantity = sum(o.remaining_quantity for o in book["asks"][price])
            asks.append([float(price), float(total_quantity)])
        
        return OrderBookSnapshot(symbol=symbol, bids=bids, asks=asks)
    
    async def execute_trade(self, maker_order: Order, taker_order: Order, 
                           quantity: float, price: float) -> Trade:
        """Execute a trade between maker and taker orders"""
        trade = Trade(
            symbol=maker_order.symbol,
            price=price,
            quantity=quantity,
            aggressor_side=taker_order.side,
            maker_order_id=maker_order.order_id,
            taker_order_id=taker_order.order_id
        )
        
        # Update order quantities
        maker_order.remaining_quantity -= quantity
        taker_order.remaining_quantity -= quantity
        
        # Update order statuses
        if maker_order.remaining_quantity == 0:
            maker_order.status = "filled"
            self.remove_order_from_book(maker_order)
        elif maker_order.remaining_quantity < maker_order.quantity:
            maker_order.status = "partially_filled"
        
        if taker_order.remaining_quantity == 0:
            taker_order.status = "filled"
        elif taker_order.remaining_quantity < taker_order.quantity:
            taker_order.status = "partially_filled"
        
        # Save trade to database
        trade_dict = trade.model_dump()
        trade_dict["timestamp"] = trade_dict["timestamp"].isoformat()
        await db.trades.insert_one(trade_dict)
        
        # Update orders in database
        for order in [maker_order, taker_order]:
            order_dict = order.model_dump()
            order_dict["timestamp"] = order_dict["timestamp"].isoformat()
            await db.orders.update_one(
                {"order_id": order.order_id},
                {"$set": order_dict},
                upsert=True
            )
        
        # Broadcast trade to WebSocket clients
        await self.broadcast_trade(trade)
        
        logger.info(f"Trade executed: {trade.trade_id} - {quantity} @ {price} {trade.symbol}")
        return trade
    
    async def match_order(self, order: Order) -> List[Trade]:
        """Match an incoming order against the order book"""
        trades = []
        self.ensure_order_book(order.symbol)
        book = self.order_books[order.symbol]
        
        if order.side == "buy":
            # Match against asks (sells)
            while order.remaining_quantity > 0 and book["asks"]:
                best_ask_price = book["asks"].keys()[0]
                
                # For limit orders, check if price is acceptable
                if order.order_type == "limit" and order.price < best_ask_price:
                    break
                
                ask_orders = book["asks"][best_ask_price]
                
                while order.remaining_quantity > 0 and ask_orders:
                    maker_order = ask_orders[0]  # FIFO
                    
                    # Determine trade quantity
                    trade_quantity = min(order.remaining_quantity, maker_order.remaining_quantity)
                    
                    # Execute trade
                    trade = await self.execute_trade(maker_order, order, trade_quantity, best_ask_price)
                    trades.append(trade)
                    
                    if maker_order.remaining_quantity == 0:
                        pass  # Already removed in execute_trade
        
        else:  # sell
            # Match against bids (buys)
            while order.remaining_quantity > 0 and book["bids"]:
                best_bid_price = -book["bids"].keys()[0]
                
                # For limit orders, check if price is acceptable
                if order.order_type == "limit" and order.price > best_bid_price:
                    break
                
                bid_orders = book["bids"][-best_bid_price]
                
                while order.remaining_quantity > 0 and bid_orders:
                    maker_order = bid_orders[0]  # FIFO
                    
                    # Determine trade quantity
                    trade_quantity = min(order.remaining_quantity, maker_order.remaining_quantity)
                    
                    # Execute trade
                    trade = await self.execute_trade(maker_order, order, trade_quantity, best_bid_price)
                    trades.append(trade)
                    
                    if maker_order.remaining_quantity == 0:
                        pass  # Already removed in execute_trade
        
        return trades
    
    async def submit_order(self, order_submission: OrderSubmission) -> Dict:
        """Submit a new order to the matching engine"""
        async with self.lock:
            # Validate order
            if order_submission.order_type in ["limit", "ioc", "fok"] and order_submission.price is None:
                raise ValueError(f"{order_submission.order_type.upper()} order requires a price")
            
            # Create order object
            order = Order(
                symbol=order_submission.symbol,
                order_type=order_submission.order_type,
                side=order_submission.side,
                quantity=order_submission.quantity,
                price=order_submission.price,
                remaining_quantity=order_submission.quantity
            )
            
            # Save order to database
            order_dict = order.model_dump()
            order_dict["timestamp"] = order_dict["timestamp"].isoformat()
            await db.orders.insert_one(order_dict)
            
            logger.info(f"Order submitted: {order.order_id} - {order.side} {order.quantity} {order.symbol} @ {order.price}")
            
            # Process order based on type
            trades = []
            
            if order.order_type == "market":
                # Market order: match immediately at best available prices
                trades = await self.match_order(order)
                if order.remaining_quantity > 0:
                    order.status = "partially_filled" if trades else "cancelled"
                    logger.warning(f"Market order {order.order_id} partially filled or cancelled - insufficient liquidity")
            
            elif order.order_type == "limit":
                # Limit order: match what can be matched, rest goes to book
                trades = await self.match_order(order)
                if order.remaining_quantity > 0:
                    self.add_order_to_book(order)
            
            elif order.order_type == "ioc":
                # Immediate-Or-Cancel: match what can be matched, cancel the rest
                trades = await self.match_order(order)
                if order.remaining_quantity > 0:
                    order.status = "cancelled"
                    logger.info(f"IOC order {order.order_id} - unfilled portion cancelled")
            
            elif order.order_type == "fok":
                # Fill-Or-Kill: only fill if entire order can be filled immediately
                self.ensure_order_book(order.symbol)
                book = self.order_books[order.symbol]
                
                # Check if full order can be filled
                can_fill = False
                required_quantity = order.quantity
                
                if order.side == "buy":
                    available = 0
                    for price in book["asks"].keys():
                        if order.price < price:
                            break
                        available += sum(o.remaining_quantity for o in book["asks"][price])
                        if available >= required_quantity:
                            can_fill = True
                            break
                else:  # sell
                    available = 0
                    for price in book["bids"].keys():
                        if order.price > -price:
                            break
                        available += sum(o.remaining_quantity for o in book["bids"][price])
                        if available >= required_quantity:
                            can_fill = True
                            break
                
                if can_fill:
                    trades = await self.match_order(order)
                else:
                    order.status = "cancelled"
                    logger.info(f"FOK order {order.order_id} cancelled - cannot be fully filled")
            
            # Broadcast updates
            await self.broadcast_order_book(order.symbol)
            await self.broadcast_bbo(order.symbol)
            
            return {
                "order_id": order.order_id,
                "status": order.status,
                "filled_quantity": order.quantity - order.remaining_quantity,
                "remaining_quantity": order.remaining_quantity,
                "trades": [t.model_dump() for t in trades]
            }
    
    async def broadcast_order_book(self, symbol: str):
        """Broadcast order book update to all connected clients"""
        snapshot = self.get_order_book_snapshot(symbol)
        message = snapshot.model_dump()
        message["timestamp"] = message["timestamp"].isoformat()
        
        disconnected = []
        for ws in self.orderbook_connections:
            try:
                await ws.send_json(message)
            except:
                disconnected.append(ws)
        
        for ws in disconnected:
            self.orderbook_connections.remove(ws)
    
    async def broadcast_trade(self, trade: Trade):
        """Broadcast trade execution to all connected clients"""
        message = trade.model_dump()
        message["timestamp"] = message["timestamp"].isoformat()
        
        disconnected = []
        for ws in self.trade_connections:
            try:
                await ws.send_json(message)
            except:
                disconnected.append(ws)
        
        for ws in disconnected:
            self.trade_connections.remove(ws)
    
    async def broadcast_bbo(self, symbol: str):
        """Broadcast BBO update to all connected clients"""
        bbo = self.get_bbo(symbol)
        message = bbo.model_dump()
        message["timestamp"] = message["timestamp"].isoformat()
        
        disconnected = []
        for ws in self.bbo_connections:
            try:
                await ws.send_json(message)
            except:
                disconnected.append(ws)
        
        for ws in disconnected:
            self.bbo_connections.remove(ws)

# Global matching engine instance
matching_engine = MatchingEngine()

# ============== REST API ROUTES ==============

@api_router.get("/")
async def root():
    return {
        "message": "Cryptocurrency Matching Engine API",
        "version": "1.0"
    }

@api_router.post("/orders")
async def submit_order(order: OrderSubmission):
    """Submit a new order to the matching engine"""
    try:
        result = await matching_engine.submit_order(order)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error submitting order: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@api_router.get("/orderbook/{symbol}")
async def get_order_book(symbol: str, depth: int = 10):
    """Get current order book snapshot for a symbol"""
    try:
        snapshot = matching_engine.get_order_book_snapshot(symbol, depth)
        return snapshot
    except Exception as e:
        logger.error(f"Error getting order book: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@api_router.get("/bbo/{symbol}")
async def get_bbo(symbol: str):
    """Get current Best Bid and Offer for a symbol"""
    try:
        bbo = matching_engine.get_bbo(symbol)
        return bbo
    except Exception as e:
        logger.error(f"Error getting BBO: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@api_router.get("/trades/{symbol}")
async def get_trades(symbol: str, limit: int = 50):
    """Get recent trades for a symbol"""
    try:
        trades = await db.trades.find(
            {"symbol": symbol},
            {"_id": 0}
        ).sort("timestamp", -1).limit(limit).to_list(limit)
        return {"symbol": symbol, "trades": trades}
    except Exception as e:
        logger.error(f"Error getting trades: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@api_router.get("/orders")
async def get_orders(symbol: Optional[str] = None, limit: int = 100):
    """Get recent orders"""
    try:
        query = {"symbol": symbol} if symbol else {}
        orders = await db.orders.find(
            query,
            {"_id": 0}
        ).sort("timestamp", -1).limit(limit).to_list(limit)
        return {"orders": orders}
    except Exception as e:
        logger.error(f"Error getting orders: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

# ============== WEBSOCKET ROUTES ==============

@app.websocket("/ws/orderbook")
async def websocket_orderbook(websocket: WebSocket):
    """WebSocket endpoint for real-time order book updates"""
    await websocket.accept()
    matching_engine.orderbook_connections.append(websocket)
    logger.info("Client connected to order book stream")
    
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        matching_engine.orderbook_connections.remove(websocket)
        logger.info("Client disconnected from order book stream")

@app.websocket("/ws/trades")
async def websocket_trades(websocket: WebSocket):
    """WebSocket endpoint for real-time trade execution feed"""
    await websocket.accept()
    matching_engine.trade_connections.append(websocket)
    logger.info("Client connected to trade stream")
    
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        matching_engine.trade_connections.remove(websocket)
        logger.info("Client disconnected from trade stream")

@app.websocket("/ws/bbo")
async def websocket_bbo(websocket: WebSocket):
    """WebSocket endpoint for real-time BBO updates"""
    await websocket.accept()
    matching_engine.bbo_connections.append(websocket)
    logger.info("Client connected to BBO stream")
    
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        matching_engine.bbo_connections.remove(websocket)
        logger.info("Client disconnected from BBO stream")

# Include the router in the main app
app.include_router(api_router)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
