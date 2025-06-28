#!/bin/bash

# Generate SSL Certificate for IP Address
echo "🔐 Generating SSL certificate for IP address..."

# Get your IP address
IP_ADDRESS=$(curl -s ifconfig.me)
echo "📡 Detected IP: $IP_ADDRESS"

# Create certificates directory
mkdir -p ssl

# Generate private key
openssl genrsa -out ssl/private.key 2048

# Generate certificate signing request with IP
openssl req -new -key ssl/private.key -out ssl/certificate.csr -subj "/C=US/ST=State/L=City/O=Organization/CN=$IP_ADDRESS"

# Generate self-signed certificate
openssl x509 -req -days 365 -in ssl/certificate.csr -signkey ssl/private.key -out ssl/certificate.crt

echo "✅ SSL certificate generated for IP: $IP_ADDRESS"
echo "📁 Files created:"
echo "   - ssl/private.key (private key)"
echo "   - ssl/certificate.crt (certificate)"
echo ""
echo "🌐 Access your app at:"
echo "   - HTTP: http://$IP_ADDRESS"
echo "   - HTTPS: https://$IP_ADDRESS"
echo ""
echo "⚠️  Note: This is a self-signed certificate. You'll need to accept it in your browser." 