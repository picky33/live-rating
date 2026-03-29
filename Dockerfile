# Use lightweight Node base image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Install curl (for healthchecks) + clean up
RUN apt-get update \
    && apt-get install -y curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy rest of the app
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
