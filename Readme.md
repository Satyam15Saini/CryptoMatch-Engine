# Cryptocurrency Matching Engine

A high-performance cryptocurrency matching engine implementing REG NMS-inspired principles with real-time order matching and WebSocket data streaming.

## 🎯 Purpose

This project implements a production-grade matching engine for cryptocurrency trading that provides:

- **Price-time priority matching** - Orders matched by best price, then FIFO within price levels
- **Internal order protection** - Prevents trade-throughs, ensures best execution
- **Real-time data streaming** - Live order book, BBO, and trade updates via WebSockets
- **Multiple order types** - Support for Market, Limit, IOC, and FOK orders

## 🚀 Tech Stack

### Backend
- **FastAPI** - High-performance async Python web framework
- **Python 3.11+** - Core backend language
- **MongoDB** - NoSQL database for orders and trades
- **Motor** - Async MongoDB driver
- **Uvicorn** - ASGI server
- **WebSockets** - Real-time data streaming
- **SortedContainers** - Efficient order book data structures

### Frontend
- **React 19** - UI framework
- **TailwindCSS** - Utility-first CSS framework
- **Axios** - HTTP client for API calls
- **WebSocket API** - Real-time updates
- **Radix UI** - Accessible component primitives
- **CRACO** - Create React App Configuration Override

### Infrastructure
- **Docker** - MongoDB containerization
- **REST API** - Order submission and data retrieval
- **WebSocket Endpoints** - Real-time market data feeds

## 📦 Installation

### Prerequisites
- Python 3.11+
- Node.js 18+
- Docker Desktop
- MongoDB

### Backend Setup
cd backend
pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8001 --reload

### Frontend Setup
cd frontend
npm install --legacy-peer-deps
npm start

### Database Setup
docker run -d -p 27017:27017 --name mongodb mongo:latest

## 📊 Features

- Real-time order book visualization
- Live best bid/offer (BBO) display
- Trade execution history
- Multiple order types (Market, Limit, IOC, FOK)
- WebSocket streaming for live updates
- Price-time priority matching algorithm
- REG NMS-compliant order protection