.PHONY: build run test clean docker-build docker-run

# Build variables
BINARY_NAME=price-bot
BUILD_DIR=./bin
CMD_DIR=./cmd/bot

build: ## Build the binary
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 go build -ldflags="-s -w" -o $(BUILD_DIR)/$(BINARY_NAME) $(CMD_DIR)

run: ## Run the bot (requires ECDSA_PRIVATE_KEY)
	@if [ -z "$$ECDSA_PRIVATE_KEY" ]; then \
		echo "Error: ECDSA_PRIVATE_KEY not set"; \
		exit 1; \
	fi
	go run $(CMD_DIR)

test: ## Run tests
	go test -v -race ./...

clean: ## Clean build artifacts
	rm -rf $(BUILD_DIR) build/

docker-build: ## Build Docker image
	docker build -t $(BINARY_NAME):latest .

docker-run: ## Run Docker container
	@if [ -z "$$ECDSA_PRIVATE_KEY" ]; then \
		echo "Error: ECDSA_PRIVATE_KEY not set"; \
		exit 1; \
	fi
	docker run --rm -it -e ECDSA_PRIVATE_KEY=$$ECDSA_PRIVATE_KEY -p 8080:8080 $(BINARY_NAME):latest
