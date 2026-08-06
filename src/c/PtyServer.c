// https://chatgpt.com/share/66e7b5fe-cb08-8004-aa82-66f443479008
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <ctype.h>
#include <time.h>
#include <pty.h>
#include <uv.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <stdarg.h>
#include <openssl/aes.h>
#include <openssl/rand.h>

#define DEFAULT_TCP_PORT 5000
#define SYMLINK_DIR "/home/project"

typedef struct PicoDevice {
    int picoNumber;
    char serialId[256];
    uv_tcp_t *client;
    uv_pipe_t *pty_pipe;
    int pty_fd_master;
    int pty_fd_slave;
    char pts_name[256];
    uv_stream_t *stream;
    struct PicoDevice *next;
    int encryption_supported; // 0 = no encryption, 1 = encryption supported
    unsigned char encryption_key[32]; // AES-256 key
    unsigned char iv[AES_BLOCK_SIZE]; // Initialization Vector for AES
} PicoDevice;

PicoDevice *picoDevices = NULL;
int nextPicoNumber = 1;
uv_loop_t *loop;

void logMessage(const char *format, ...) {
    va_list args;
    va_start(args, format);

    time_t now = time(NULL);
    struct tm *t = localtime(&now);
    char timeStr[64];
    strftime(timeStr, sizeof(timeStr), "%b %d %H:%M:%S", t);
    printf("%s ", timeStr);
    vprintf(format, args);
    printf("\n");
    fflush(stdout);

    va_end(args);
}

void daemonize() {
    pid_t pid = fork();

    if (pid < 0) {
        // Fork failed
        perror("fork");
        exit(EXIT_FAILURE);
    }
    if (pid > 0) {
        // Parent process exits
        exit(EXIT_SUCCESS);
    }

    // Child process continues

    // Create a new session and set process group
    if (setsid() < 0) {
        perror("setsid");
        exit(EXIT_FAILURE);
    }

    // Ignore the SIGCHLD signal to avoid zombies
    signal(SIGCHLD, SIG_IGN);

    // Fork again to ensure the process is not a session leader
    pid = fork();
    if (pid < 0) {
        perror("fork");
        exit(EXIT_FAILURE);
    }
    if (pid > 0) {
        // Parent exits again
        exit(EXIT_SUCCESS);
    }

    // Child continues

    // Redirect standard file descriptors to /dev/null
    int devnull = open("/dev/null", O_RDWR);
    if (devnull < 0) {
        perror("open /dev/null");
        exit(EXIT_FAILURE);
    }
    dup2(devnull, STDIN_FILENO);
    dup2(devnull, STDOUT_FILENO);
    dup2(devnull, STDERR_FILENO);
    if (devnull > STDERR_FILENO) {
        close(devnull);
    }

    // Change working directory to root
    if (chdir("/") < 0) {
        perror("chdir");
        exit(EXIT_FAILURE);
    }
}

void createSymlink(int picoNumber, const char *ptsName) {
    char symlinkPath[512];
    snprintf(symlinkPath, sizeof(symlinkPath), "%s/pico%d", SYMLINK_DIR, picoNumber);
    struct stat st;
    if (lstat(symlinkPath, &st) == -1) {
        if (symlink(ptsName, symlinkPath) == -1) {
            logMessage("Error creating symlink: %s", strerror(errno));
        } else {
            logMessage("Created symlink '%s' -> '%s'", symlinkPath, ptsName);
        }
    } else {
        logMessage("Symlink '%s' already exists", symlinkPath);
    }
}

void removeSymlink(int picoNumber) {
    char symlinkPath[512];
    snprintf(symlinkPath, sizeof(symlinkPath), "%s/pico%d", SYMLINK_DIR, picoNumber);
    if (unlink(symlinkPath) == -1) {
        logMessage("Error removing symlink: %s", strerror(errno));
    } else {
        logMessage("Removed symlink '%s'", symlinkPath);
    }
}

void cleanPicoResources(PicoDevice *picoDevice) {
    if (picoDevice->pty_fd_master != -1) {
        close(picoDevice->pty_fd_master);
        picoDevice->pty_fd_master = -1;
    }
    if (picoDevice->pty_fd_slave != -1) {
        close(picoDevice->pty_fd_slave);
        picoDevice->pty_fd_slave = -1;
    }
    removeSymlink(picoDevice->picoNumber);
    if (picoDevice->client) {
        uv_close((uv_handle_t *)picoDevice->client, NULL);
        picoDevice->client = NULL;
    }
    if (picoDevice->pty_pipe) {
        uv_close((uv_handle_t *)picoDevice->pty_pipe, NULL);
        picoDevice->pty_pipe = NULL;
    }
    // Remove from picoDevices list
    PicoDevice **pp = &picoDevices;
    while (*pp && *pp != picoDevice) {
        pp = &(*pp)->next;
    }
    if (*pp == picoDevice) {
        *pp = picoDevice->next;
    }
    logMessage("Pico%d pty and socket destroyed", picoDevice->picoNumber);
    free(picoDevice);
}

void alloc_buffer(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
    buf->base = (char *)malloc(suggested_size);
    buf->len = suggested_size;
}

void decrypt_message(const unsigned char *ciphertext, int ciphertext_len, const unsigned char *key, unsigned char *iv, unsigned char *plaintext) {
    AES_KEY aes_key;

    // Initialize decryption key structure
    if (AES_set_decrypt_key(key, 256, &aes_key) < 0) {
        fprintf(stderr, "Failed to set decryption key.\n");
        exit(EXIT_FAILURE);
    }

    // Decrypt the data using AES CFB mode
    int num = 0; // Used internally by AES_cfb128_encrypt
    AES_cfb128_encrypt(ciphertext, plaintext, ciphertext_len, &aes_key, iv, &num, AES_DECRYPT);
}

void encrypt_message(const unsigned char *plaintext, int plaintext_len, const unsigned char *key, unsigned char *iv, unsigned char *ciphertext) {
    AES_KEY aes_key;

    // Initialize encryption key structure
    if (AES_set_encrypt_key(key, 256, &aes_key) < 0) {
        fprintf(stderr, "Failed to set encryption key.\n");
        exit(EXIT_FAILURE);
    }

    // Encrypt the data using AES CFB mode
    int num = 0; // Used internally by AES_cfb128_encrypt
    AES_cfb128_encrypt(plaintext, ciphertext, plaintext_len, &aes_key, iv, &num, AES_ENCRYPT);
}

void on_pty_read(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf);
void on_client_write(uv_write_t *req, int status);

void setupPicoPty(PicoDevice *picoDevice) {
    int master_fd, slave_fd;
    char pts_name[256];

    if (openpty(&master_fd, &slave_fd, NULL, NULL, NULL) == -1) {
        logMessage("Error creating pty: %s", strerror(errno));
        return;
    }

    if (ptsname_r(master_fd, pts_name, sizeof(pts_name)) != 0) {
        logMessage("Error getting pts name: %s", strerror(errno));
        close(master_fd);
        close(slave_fd);
        return;
    }

    picoDevice->pty_fd_master = master_fd;
    picoDevice->pty_fd_slave = slave_fd;
    strcpy(picoDevice->pts_name, pts_name);
    createSymlink(picoDevice->picoNumber, pts_name);

    picoDevice->pty_pipe = (uv_pipe_t *)malloc(sizeof(uv_pipe_t));
    uv_pipe_init(loop, picoDevice->pty_pipe, 0);
    uv_pipe_open(picoDevice->pty_pipe, master_fd);

    picoDevice->pty_pipe->data = picoDevice;
    uv_read_start((uv_stream_t *)picoDevice->pty_pipe, alloc_buffer, on_pty_read);
}

void on_client_write(uv_write_t *req, int status) {
    if (status) {
        logMessage("Error writing to client: %s", uv_strerror(status));
    }
    free(req->data);
    free(req);
}

void on_pty_read(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
    PicoDevice *picoDevice = stream->data;
    if (nread > 0) {
        uv_write_t *write_req = (uv_write_t *)malloc(sizeof(uv_write_t));
        unsigned char encrypted_data[1024];

        if (picoDevice->encryption_supported) {
            encrypt_message((unsigned char *)buf->base, nread, picoDevice->encryption_key, picoDevice->iv, encrypted_data);
            uv_buf_t write_buf = uv_buf_init((char *)encrypted_data, nread);
            write_req->data = (void *)encrypted_data;
        } else {
            uv_buf_t write_buf = uv_buf_init(buf->base, nread);
            write_req->data = buf->base;
        }

        uv_write(write_req, (uv_stream_t *)picoDevice->client, &write_buf, 1, on_client_write);
        char *log_buf = (char *)malloc(nread + 1);
        memcpy(log_buf, buf->base, nread);
        log_buf[nread] = '\0';
        logMessage("Pico%d command: %s", picoDevice->picoNumber, log_buf);
        free(log_buf);
        return;
    } else if (nread < 0) {
        if (nread != UV_EOF) {
            logMessage("Error reading from pty: %s", uv_strerror(nread));
        }
        uv_close((uv_handle_t *)stream, NULL);
    }
    free(buf->base);
}

void on_client_read(uv_stream_t *client, ssize_t nread, const uv_buf_t *buf);

void on_client_write_to_pty(uv_write_t *req, int status) {
    if (status) {
        logMessage("Error writing to pty: %s", uv_strerror(status));
    }
    free(req->data);
    free(req);
}

void on_client_read(uv_stream_t *client, ssize_t nread, const uv_buf_t *buf) {
    PicoDevice *picoDevice = client->data;

    if (nread > 0) {
        buf->base[nread] = '\0';
        char *message = buf->base;
        while (isspace(*message)) message++;
        char *end = message + strlen(message) - 1;
        while (end > message && isspace(*end)) *end-- = '\0';

        // Check if the Pico supports encryption
        if (strncmp(message, "pico_encrypt", 12) == 0) {
            picoDevice->encryption_supported = 1;
            // Here we could derive or set an encryption key and IV
            RAND_bytes(picoDevice->encryption_key, sizeof(picoDevice->encryption_key));
            RAND_bytes(picoDevice->iv, AES_BLOCK_SIZE);
            logMessage("Pico%d supports encryption.", picoDevice->picoNumber);
        } else if (strncmp(message, "pico_", 5) == 0) {
            // Handle Pico device connection and identification as before
            char serialId[256];
            strncpy(serialId, message + 5, sizeof(serialId) - 1);
            serialId[sizeof(serialId) - 1] = '\0';

            PicoDevice *existingDevice = picoDevices;
            while (existingDevice != NULL) {
                if (strcmp(existingDevice->serialId, serialId) == 0) {
                    picoDevice->picoNumber = existingDevice->picoNumber;
                    logMessage("Pico%d client reconnected", picoDevice->picoNumber);
                    break;
                }
                existingDevice = existingDevice->next;
            }
            if (existingDevice == NULL) {
                picoDevice->picoNumber = nextPicoNumber++;
                strcpy(picoDevice->serialId, serialId);
                picoDevice->next = picoDevices;
                picoDevices = picoDevice;
                setupPicoPty(picoDevice);
                logMessage("Pico%d client connected", picoDevice->picoNumber);
            }
            if (picoDevice->pty_pipe) {
                picoDevice->pty_pipe->data = picoDevice;
            }
        } else if (picoDevice->picoNumber > 0) {
            unsigned char plaintext[1024];
            if (picoDevice->encryption_supported) {
                decrypt_message((unsigned char *)message, strlen(message), picoDevice->encryption_key, picoDevice->iv, plaintext);
                strcpy(message, (char *)plaintext);  // Decrypt message and store in the original buffer
            }
            uv_write_t *write_req = (uv_write_t *)malloc(sizeof(uv_write_t));
            size_t msg_len = strlen(message);
            char *msg_with_cr = (char *)malloc(msg_len + 2);
            strcpy(msg_with_cr, message);
            strcat(msg_with_cr, "\r");
            uv_buf_t write_buf = uv_buf_init(msg_with_cr, strlen(msg_with_cr));
            write_req->data = msg_with_cr;
            uv_write(write_req, (uv_stream_t *)picoDevice->pty_pipe, &write_buf, 1, on_client_write_to_pty);
            logMessage("Pico%d response: %s", picoDevice->picoNumber, message);
        }
        free(buf->base);
        return;
    } else if (nread < 0) {
        if (nread != UV_EOF) {
            logMessage("Error reading from client: %s", uv_strerror(nread));
        }
        uv_close((uv_handle_t *)client, NULL);
        if (picoDevice) {
            cleanPicoResources(picoDevice);
        }
    }
    free(buf->base);
}

void on_new_connection(uv_stream_t *server, int status) {
    if (status < 0) {
        logMessage("New connection error: %s", uv_strerror(status));
        return;
    }

    PicoDevice *picoDevice = (PicoDevice *)malloc(sizeof(PicoDevice));
    memset(picoDevice, 0, sizeof(PicoDevice));
    picoDevice->client = (uv_tcp_t *)malloc(sizeof(uv_tcp_t));
    uv_tcp_init(loop, picoDevice->client);
    if (uv_accept(server, (uv_stream_t *)picoDevice->client) == 0) {
        picoDevice->client->data = picoDevice;
        uv_read_start((uv_stream_t *)picoDevice->client, alloc_buffer, on_client_read);
    } else {
        uv_close((uv_handle_t *)picoDevice->client, NULL);
    }
}

void on_signal(uv_signal_t *handle, int signum) {
    logMessage("Received signal %d, cleaning up...", signum);
    PicoDevice *picoDevice = picoDevices;
    while (picoDevice != NULL) {
        PicoDevice *next = picoDevice->next;
        cleanPicoResources(picoDevice);
        picoDevice = next;
    }
    uv_signal_stop(handle);
    uv_stop(loop);
}

void print_usage(const char *prog_name) {
    printf("Usage: %s [-p port] [-d]\n", prog_name);
    printf("  -p, --port PORT    Specify the TCP port to listen on (default: %d)\n", DEFAULT_TCP_PORT);
    printf("  -d, --daemon       Run as a daemon\n");
    printf("  -h, --help         Show this help message\n");
}

int main(int argc, char *argv[]) {
    loop = uv_default_loop();
    int tcp_port = DEFAULT_TCP_PORT;
    int run_as_daemon = 0;

    for (int i = 1; i < argc; i++) {
        if ((strcmp(argv[i], "-p") == 0 || strcmp(argv[i], "--port") == 0) && i + 1 < argc) {
            tcp_port = atoi(argv[++i]);
            if (tcp_port <= 0 || tcp_port > 65535) {
                fprintf(stderr, "Invalid port number: %s\n", argv[i]);
                return 1;
            }
        } else if (strcmp(argv[i], "-d") == 0 || strcmp(argv[i], "--daemon") == 0) {
            run_as_daemon = 1;
        } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "Unknown argument: %s\n", argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }

    if (run_as_daemon) {
        daemonize();
    }

    uv_tcp_t server;
    uv_tcp_init(loop, &server);

    struct sockaddr_in addr;
    int r = uv_ip4_addr("0.0.0.0", tcp_port, &addr);
    if (r != 0) {
        logMessage("Error initializing address: %s", uv_strerror(r));
        return 1;
    }

    r = uv_tcp_bind(&server, (const struct sockaddr *)&addr, 0);
    if (r != 0) {
        logMessage("Error binding server: %s", uv_strerror(r));
        return 1;
    }

    r = uv_listen((uv_stream_t *)&server, 128, on_new_connection);
    if (r != 0) {
        logMessage("Error listening: %s", uv_strerror(r));
        return 1;
    }

    logMessage("Server listening on port %d", tcp_port);

    uv_signal_t sigint;
    uv_signal_init(loop, &sigint);
    uv_signal_start(&sigint, on_signal, SIGINT);

    uv_signal_t sigterm;
    uv_signal_init(loop, &sigterm);
    uv_signal_start(&sigterm, on_signal, SIGTERM);

    uv_run(loop, UV_RUN_DEFAULT);

    return 0;
}
