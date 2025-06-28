#!/bin/bash

# Generate SSL Certificate for Local Development
echo "🔐 Generating SSL certificate for local development..."

# Create certificates directory
mkdir -p ssl

# Generate private key
openssl genrsa -out ssl/private.key 2048

# Generate certificate signing request
openssl req -new -key ssl/private.key -out ssl/certificate.csr -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

# Generate self-signed certificate
openssl x509 -req -days 365 -in ssl/certificate.csr -signkey ssl/private.key -out ssl/certificate.crt

echo "✅ SSL certificate generated in ssl/ directory"
echo "📁 Files created:"
echo "   - ssl/private.key (private key)"
echo "   - ssl/certificate.crt (certificate)"
echo ""
echo "⚠️  Note: This is a self-signed certificate. You'll need to accept it in your browser." 