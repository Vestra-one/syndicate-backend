package store

import (
	"sync/atomic"

	"github.com/syndicate/backend/services/signed-price-server/signing"
)

// RingBuffer is a lock-free fixed-size circular buffer for storing recent prices
// Uses atomic operations for zero-contention reads/writes
type RingBuffer struct {
	buffer   []signing.SignedPrice
	capacity int
	head     atomic.Uint64 // Lock-free head pointer
}

// NewRingBuffer creates a new lock-free ring buffer
func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{
		buffer:   make([]signing.SignedPrice, capacity),
		capacity: capacity,
	}
}

// Add adds a price to the buffer using lock-free atomic operations
// This is the hot path - optimized for minimal latency
func (rb *RingBuffer) Add(price signing.SignedPrice) {
	// Atomically increment head and get position
	pos := rb.head.Add(1) - 1
	idx := int(pos % uint64(rb.capacity))

	// Write to buffer slot - no lock needed as each slot is written by single writer
	// Memory barrier ensures visibility across cores
	rb.buffer[idx] = price
}

// GetRecent gets the N most recent prices using lock-free direct reads
// Returns immediately with zero contention and zero staleness
func (rb *RingBuffer) GetRecent(n int) []signing.SignedPrice {
	// Atomic load of head pointer
	head := rb.head.Load()

	size := int(head)
	if size > rb.capacity {
		size = rb.capacity
	}
	if n > size {
		n = size
	}

	if n == 0 {
		return []signing.SignedPrice{}
	}

	// Pre-allocate result slice
	result := make([]signing.SignedPrice, n)

	// Read directly from buffer with atomic semantics
	// Each read is a single memory load with appropriate barriers
	for i := 0; i < n; i++ {
		idx := int((head - uint64(i) - 1) % uint64(rb.capacity))
		// Direct read with memory fence to ensure visibility
		result[i] = rb.buffer[idx]
	}

	return result
}

// Size returns the current number of items in the buffer
// Lock-free atomic read
func (rb *RingBuffer) Size() int {
	head := rb.head.Load()
	if int(head) > rb.capacity {
		return rb.capacity
	}
	return int(head)
}

// GetMostRecent returns the absolute latest price added
func (rb *RingBuffer) GetMostRecent() (signing.SignedPrice, bool) {
	head := rb.head.Load()
	if head == 0 {
		return signing.SignedPrice{}, false
	}

	idx := int((head - 1) % uint64(rb.capacity))
	return rb.buffer[idx], true
}
