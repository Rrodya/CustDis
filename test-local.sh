#!/bin/bash

# Local Testing Script for Voice Chat App
set -e

echo "🧪 Testing Voice Chat App locally..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    print_error "Docker is not running. Please start Docker first."
    exit 1
fi

# Stop any existing containers
print_status "Stopping existing containers..."
docker-compose down --remove-orphans || true

# Build and start services
print_status "Building and starting services..."
docker-compose up --build -d

# Wait for services to be ready
print_status "Waiting for services to be ready..."
sleep 15

# Test backend
print_status "Testing backend..."
if curl -s http://localhost:8080 > /dev/null; then
    print_status "✅ Backend is responding on port 8080"
else
    print_warning "⚠️  Backend might not be ready yet on port 8080"
fi

# Test frontend
print_status "Testing frontend..."
if curl -s http://localhost > /dev/null; then
    print_status "✅ Frontend is responding on port 80"
else
    print_warning "⚠️  Frontend might not be ready yet on port 80"
fi

# Show service status
print_status "Service status:"
docker-compose ps

echo ""
print_status "🎉 Local testing completed!"
print_status "🌐 Frontend: http://localhost"
print_status "🔧 Backend API: http://localhost:8080"
print_status "📡 WebSocket: ws://localhost/ws"
echo ""
print_status "To view logs: docker-compose logs -f"
print_status "To stop services: docker-compose down"
print_status "To test WebSocket connection, open the frontend in your browser" 