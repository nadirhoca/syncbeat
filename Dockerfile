FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Expose Cloud Run's expected port (Cloud Run sets $PORT to 8080)
EXPOSE 8080

# Set environment variable for Node production mode
ENV NODE_ENV=production

# Start the server; the server reads PORT from env or defaults to 3000
CMD ["node", "server.js"]
