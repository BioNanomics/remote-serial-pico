# Makefile for PtyServer

# Compiler and flags
CC = gcc
CFLAGS = -O2 -Wall -Wextra -Wpedantic
LIBS = -luv -lutil

# Source files and executable
SRCS = PtyServer.c
EXEC = PtyServer

# Default target
all: check_libuv $(EXEC)

# Build the executable
$(EXEC): $(SRCS)
	$(CC) $(CFLAGS) -o $(EXEC) $(SRCS) $(LIBS)

# Check if libuv is installed
check_libuv:
	@command -v pkg-config >/dev/null 2>&1 || { echo >&2 "pkg-config is required but not installed. Please install it."; exit 1; }
	@pkg-config --exists libuv || { echo >&2 "libuv is not installed. Please install libuv development package (e.g., 'libuv1-dev' on Debian/Ubuntu or 'libuv-devel' on Red Hat/Fedora)."; exit 1; }

# Run the program in the foreground with default port
run: $(EXEC)
	./$(EXEC) -p 5000

# Run the program as a daemon with default port
run-daemon: $(EXEC)
	./$(EXEC) -d -p 5000

# Clean up build files
clean:
	rm -f $(EXEC)

.PHONY: all clean run run-daemon check_libuv
