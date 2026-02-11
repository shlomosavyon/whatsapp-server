FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git
# Install dependencies
COPY package*.json ./
RUN npm install
# Copy source
COPY . .
# Build TypeScript
RUN npm run build
# Clear old WhatsApp session (forces fresh QR)
RUN rm -rf whatsapp-session
# Create session directory
RUN mkdir -p whatsapp-session
EXPOSE 3001
CMD ["npm", "start"]
