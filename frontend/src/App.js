import { useState, useEffect, useRef } from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { TrendingUp, TrendingDown, Activity, ArrowUpDown } from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;
// WebSocket uses same host as current page
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

const TradingDashboard = () => {
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [orderType, setOrderType] = useState("limit");
  const [side, setSide] = useState("buy");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [orderBook, setOrderBook] = useState({ bids: [], asks: [] });
  const [trades, setTrades] = useState([]);
  const [bbo, setBbo] = useState({ best_bid: null, best_ask: null });
  const [recentOrders, setRecentOrders] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const orderbookWs = useRef(null);
  const tradesWs = useRef(null);
  const bboWs = useRef(null);

  // WebSocket connections
  useEffect(() => {
    // Order book WebSocket
    const connectOrderbook = () => {
      orderbookWs.current = new WebSocket(`${WS_URL}/ws/orderbook`);
      
      orderbookWs.current.onopen = () => {
        console.log("Connected to orderbook stream");
      };
      
      orderbookWs.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.symbol === symbol) {
          setOrderBook({ bids: data.bids, asks: data.asks });
        }
      };
      
      orderbookWs.current.onerror = (error) => {
        console.error("Orderbook WebSocket error:", error);
      };
      
      orderbookWs.current.onclose = () => {
        console.log("Orderbook WebSocket closed, reconnecting...");
        setTimeout(connectOrderbook, 3000);
      };
    };

    // Trades WebSocket
    const connectTrades = () => {
      tradesWs.current = new WebSocket(`${WS_URL}/ws/trades`);
      
      tradesWs.current.onopen = () => {
        console.log("Connected to trades stream");
      };
      
      tradesWs.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.symbol === symbol) {
          setTrades(prev => [data, ...prev].slice(0, 50));
        }
      };
      
      tradesWs.current.onerror = (error) => {
        console.error("Trades WebSocket error:", error);
      };
      
      tradesWs.current.onclose = () => {
        console.log("Trades WebSocket closed, reconnecting...");
        setTimeout(connectTrades, 3000);
      };
    };

    // BBO WebSocket
    const connectBBO = () => {
      bboWs.current = new WebSocket(`${WS_URL}/ws/bbo`);
      
      bboWs.current.onopen = () => {
        console.log("Connected to BBO stream");
      };
      
      bboWs.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.symbol === symbol) {
          setBbo({
            best_bid: data.best_bid,
            best_bid_quantity: data.best_bid_quantity,
            best_ask: data.best_ask,
            best_ask_quantity: data.best_ask_quantity
          });
        }
      };
      
      bboWs.current.onerror = (error) => {
        console.error("BBO WebSocket error:", error);
      };
      
      bboWs.current.onclose = () => {
        console.log("BBO WebSocket closed, reconnecting...");
        setTimeout(connectBBO, 3000);
      };
    };

    connectOrderbook();
    connectTrades();
    connectBBO();

    return () => {
      if (orderbookWs.current) orderbookWs.current.close();
      if (tradesWs.current) tradesWs.current.close();
      if (bboWs.current) bboWs.current.close();
    };
  }, [symbol]);

  // Fetch initial data
  useEffect(() => {
    fetchOrderBook();
    fetchTrades();
    fetchBBO();
  }, [symbol]);

  const fetchOrderBook = async () => {
    try {
      const response = await axios.get(`${API}/orderbook/${symbol}`);
      setOrderBook({ bids: response.data.bids, asks: response.data.asks });
    } catch (error) {
      console.error("Error fetching order book:", error);
    }
  };

  const fetchTrades = async () => {
    try {
      const response = await axios.get(`${API}/trades/${symbol}`);
      setTrades(response.data.trades || []);
    } catch (error) {
      console.error("Error fetching trades:", error);
    }
  };

  const fetchBBO = async () => {
    try {
      const response = await axios.get(`${API}/bbo/${symbol}`);
      setBbo(response.data);
    } catch (error) {
      console.error("Error fetching BBO:", error);
    }
  };

  const handleSubmitOrder = async () => {
    if (!quantity || (orderType !== "market" && !price)) {
      toast.error("Please fill in all required fields");
      return;
    }

    setIsSubmitting(true);

    try {
      const orderData = {
        symbol,
        order_type: orderType,
        side,
        quantity: parseFloat(quantity),
        price: orderType !== "market" ? parseFloat(price) : null
      };

      const response = await axios.post(`${API}/orders`, orderData);
      
      toast.success(`Order ${response.data.status}`, {
        description: `Filled: ${response.data.filled_quantity}, Remaining: ${response.data.remaining_quantity}`
      });

      // Reset form
      setQuantity("");
      if (orderType === "market") {
        setPrice("");
      }

      // Refresh orders
      fetchRecentOrders();
    } catch (error) {
      toast.error("Order submission failed", {
        description: error.response?.data?.detail || error.message
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const fetchRecentOrders = async () => {
    try {
      const response = await axios.get(`${API}/orders?symbol=${symbol}&limit=20`);
      setRecentOrders(response.data.orders || []);
    } catch (error) {
      console.error("Error fetching recent orders:", error);
    }
  };

  useEffect(() => {
    fetchRecentOrders();
    const interval = setInterval(fetchRecentOrders, 5000);
    return () => clearInterval(interval);
  }, [symbol]);

  const spread = bbo.best_ask && bbo.best_bid ? (bbo.best_ask - bbo.best_bid).toFixed(2) : "N/A";
  const midPrice = bbo.best_ask && bbo.best_bid ? ((bbo.best_ask + bbo.best_bid) / 2).toFixed(2) : "N/A";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-950/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Activity className="w-8 h-8 text-cyan-400" />
              <h1 className="text-2xl font-bold text-white">CryptoMatch Engine</h1>
            </div>
            <div className="flex items-center gap-4">
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger className="w-40 bg-slate-900 border-slate-700 text-white" data-testid="symbol-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-700">
                  <SelectItem value="BTC-USDT">BTC-USDT</SelectItem>
                  <SelectItem value="ETH-USDT">ETH-USDT</SelectItem>
                  <SelectItem value="SOL-USDT">SOL-USDT</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Order Book & BBO */}
          <div className="lg:col-span-1 space-y-6">
            {/* BBO Card */}
            <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm" data-testid="bbo-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg text-white flex items-center gap-2">
                  <ArrowUpDown className="w-5 h-5 text-cyan-400" />
                  Best Bid & Offer
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-center p-3 bg-emerald-950/30 rounded-lg border border-emerald-900/30">
                  <div>
                    <div className="text-xs text-emerald-400 mb-1">Best Bid</div>
                    <div className="text-xl font-bold text-emerald-400" data-testid="best-bid">
                      {bbo.best_bid ? `$${bbo.best_bid.toFixed(2)}` : "--"}
                    </div>
                    <div className="text-xs text-slate-400">
                      {bbo.best_bid_quantity ? `${bbo.best_bid_quantity.toFixed(4)}` : "--"}
                    </div>
                  </div>
                  <TrendingUp className="w-6 h-6 text-emerald-400" />
                </div>
                
                <div className="flex justify-between items-center p-3 bg-rose-950/30 rounded-lg border border-rose-900/30">
                  <div>
                    <div className="text-xs text-rose-400 mb-1">Best Ask</div>
                    <div className="text-xl font-bold text-rose-400" data-testid="best-ask">
                      {bbo.best_ask ? `$${bbo.best_ask.toFixed(2)}` : "--"}
                    </div>
                    <div className="text-xs text-slate-400">
                      {bbo.best_ask_quantity ? `${bbo.best_ask_quantity.toFixed(4)}` : "--"}
                    </div>
                  </div>
                  <TrendingDown className="w-6 h-6 text-rose-400" />
                </div>

                <div className="pt-2 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Spread:</span>
                    <span className="text-white font-medium">{spread}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Mid Price:</span>
                    <span className="text-white font-medium">{midPrice}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Order Book */}
            <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm" data-testid="orderbook-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg text-white">Order Book</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[400px]">
                  {/* Asks */}
                  <div className="space-y-1 mb-4">
                    {orderBook.asks.slice().reverse().map((ask, idx) => (
                      <div key={`ask-${idx}`} className="flex justify-between text-sm py-1 px-2 hover:bg-rose-950/20 rounded" data-testid={`ask-level-${idx}`}>
                        <span className="text-rose-400 font-medium">${ask[0].toFixed(2)}</span>
                        <span className="text-slate-400">{ask[1].toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                  
                  <Separator className="bg-cyan-500/50 my-3" />
                  
                  {/* Bids */}
                  <div className="space-y-1">
                    {orderBook.bids.map((bid, idx) => (
                      <div key={`bid-${idx}`} className="flex justify-between text-sm py-1 px-2 hover:bg-emerald-950/20 rounded" data-testid={`bid-level-${idx}`}>
                        <span className="text-emerald-400 font-medium">${bid[0].toFixed(2)}</span>
                        <span className="text-slate-400">{bid[1].toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Middle Column: Order Form & Recent Orders */}
          <div className="lg:col-span-1 space-y-6">
            {/* Order Form */}
            <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm" data-testid="order-form-card">
              <CardHeader>
                <CardTitle className="text-lg text-white">Place Order</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Tabs value={side} onValueChange={setSide} className="w-full">
                  <TabsList className="grid w-full grid-cols-2 bg-slate-950">
                    <TabsTrigger value="buy" className="data-[state=active]:bg-emerald-600 data-[state=active]:text-white" data-testid="buy-tab">
                      Buy
                    </TabsTrigger>
                    <TabsTrigger value="sell" className="data-[state=active]:bg-rose-600 data-[state=active]:text-white" data-testid="sell-tab">
                      Sell
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                <div className="space-y-2">
                  <Label className="text-slate-300">Order Type</Label>
                  <Select value={orderType} onValueChange={setOrderType}>
                    <SelectTrigger className="bg-slate-950 border-slate-700 text-white" data-testid="order-type-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-900 border-slate-700">
                      <SelectItem value="market">Market</SelectItem>
                      <SelectItem value="limit">Limit</SelectItem>
                      <SelectItem value="ioc">IOC (Immediate-Or-Cancel)</SelectItem>
                      <SelectItem value="fok">FOK (Fill-Or-Kill)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-slate-300">Quantity</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="0.0000"
                    className="bg-slate-950 border-slate-700 text-white"
                    data-testid="quantity-input"
                  />
                </div>

                {orderType !== "market" && (
                  <div className="space-y-2">
                    <Label className="text-slate-300">Price</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      placeholder="0.00"
                      className="bg-slate-950 border-slate-700 text-white"
                      data-testid="price-input"
                    />
                  </div>
                )}

                <Button
                  onClick={handleSubmitOrder}
                  disabled={isSubmitting}
                  className={`w-full font-semibold ${side === "buy" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"}`}
                  data-testid="submit-order-button"
                >
                  {isSubmitting ? "Submitting..." : `${side === "buy" ? "Buy" : "Sell"} ${symbol.split("-")[0]}`}
                </Button>
              </CardContent>
            </Card>

            {/* Recent Orders */}
            <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm" data-testid="recent-orders-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg text-white">Recent Orders</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[300px]">
                  <div className="space-y-2">
                    {recentOrders.length === 0 ? (
                      <div className="text-center text-slate-500 py-8">No orders yet</div>
                    ) : (
                      recentOrders.map((order) => (
                        <div key={order.order_id} className="p-3 bg-slate-950/50 rounded-lg border border-slate-800" data-testid={`order-${order.order_id}`}>
                          <div className="flex justify-between items-start mb-1">
                            <Badge className={order.side === "buy" ? "bg-emerald-600" : "bg-rose-600"}>
                              {order.side.toUpperCase()}
                            </Badge>
                            <Badge variant="outline" className="border-slate-700 text-slate-300">
                              {order.order_type.toUpperCase()}
                            </Badge>
                          </div>
                          <div className="text-sm space-y-1 mt-2">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Quantity:</span>
                              <span className="text-white">{order.quantity}</span>
                            </div>
                            {order.price && (
                              <div className="flex justify-between">
                                <span className="text-slate-400">Price:</span>
                                <span className="text-white">${order.price}</span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span className="text-slate-400">Status:</span>
                              <span className={`font-medium ${
                                order.status === "filled" ? "text-emerald-400" :
                                order.status === "partially_filled" ? "text-yellow-400" :
                                order.status === "cancelled" ? "text-slate-500" :
                                "text-cyan-400"
                              }`}>
                                {order.status}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Right Column: Trade Feed */}
          <div className="lg:col-span-1">
            <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm" data-testid="trades-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg text-white">Recent Trades</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[700px]">
                  <div className="space-y-2">
                    {trades.length === 0 ? (
                      <div className="text-center text-slate-500 py-8">No trades yet</div>
                    ) : (
                      trades.map((trade, idx) => (
                        <div key={trade.trade_id || idx} className="p-3 bg-slate-950/50 rounded-lg border border-slate-800 hover:border-cyan-700/50 transition-colors" data-testid={`trade-${idx}`}>
                          <div className="flex justify-between items-center mb-2">
                            <Badge className={trade.aggressor_side === "buy" ? "bg-emerald-600" : "bg-rose-600"}>
                              {trade.aggressor_side.toUpperCase()}
                            </Badge>
                            <span className="text-xs text-slate-500">
                              {new Date(trade.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-sm">
                              <span className="text-slate-400">Price:</span>
                              <span className="text-white font-medium">${trade.price}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-slate-400">Quantity:</span>
                              <span className="text-white">{trade.quantity}</span>
                            </div>
                            <div className="text-xs text-slate-600 mt-2 truncate">
                              ID: {trade.trade_id}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<TradingDashboard />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}

export default App;