# Use ultra-lightweight Node.js production image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy the bundled zero-dependency standalone CommonJS server
COPY dist/index.cjs ./index.js

# Expose standard SSE port
EXPOSE 3000

# Set environment variable defaults
ENV PORT=3000
ENV FULLMENTION_MCP_TRANSPORT=sse

# Start the Server-Sent Events HTTP server
CMD ["node", "index.js"]
