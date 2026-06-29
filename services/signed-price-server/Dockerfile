FROM golang:1.24-alpine AS builder

RUN apk add --no-cache \
    git \
    make \
    ca-certificates \
    tzdata

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=0: static binary (no libc dependency)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-s -w -extldflags '-static'" \
    -o /app/price-bot \
    ./cmd/bot

RUN /app/price-bot version || echo "Binary built successfully"

FROM alpine:3.20

RUN apk add --no-cache \
    ca-certificates \
    tzdata

RUN addgroup -g 1000 pricebot && \
    adduser -D -u 1000 -G pricebot pricebot

WORKDIR /app

COPY --from=builder /app/price-bot /app/price-bot

COPY config/config.toml /app/config/config.toml

RUN chown -R pricebot:pricebot /app

USER pricebot

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV CONFIG_PATH=/app/config/config.toml \
    LOG_LEVEL=info \
    PORT=8080

ENTRYPOINT ["/app/price-bot"]
