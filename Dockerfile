
FROM node:18-alpine

WORKDIR /app
RUN apk add --no-cache git
# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Create session directory
RUN mkdir -p whatsapp-session

EXPOSE 3001

CMD ["npm", "start"]
