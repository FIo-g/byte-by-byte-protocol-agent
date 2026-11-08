/* N02/N06 practice fixture with a known protocol. Not the hidden experiment service. */
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int send_all(int fd, const unsigned char *message, size_t length) {
    size_t sent = 0;
    while (sent < length) {
        ssize_t count = send(fd, message + sent, length - sent, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        sent += (size_t)count;
    }
    return 0;
}

static int recv_exact(int fd, unsigned char *buffer, size_t length) {
    size_t used = 0;
    while (used < length) {
        ssize_t count = recv(fd, buffer + used, length - used, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        used += (size_t)count;
    }
    return 0;
}

static void send_error(int client, unsigned char code) {
    const unsigned char frame[7] = {0x42, 0x42, 0x01, 0xFF, 0x00, 0x01, code};
    (void)send_all(client, frame, sizeof(frame));
}

static void handle_request(int client) {
    unsigned char header[6];
    unsigned char payload[64];

    /* TCP may split the header or payload anywhere, so read exact counts only. */
    if (recv_exact(client, header, sizeof(header)) < 0) return;
    if (header[0] != 0x42 || header[1] != 0x42) { send_error(client, 0x01); return; }
    if (header[2] != 0x01) { send_error(client, 0x02); return; }
    if (header[3] != 0x01) { send_error(client, 0x03); return; }

    size_t length = ((size_t)header[4] << 8) | header[5];
    /* Reject before reading the payload, so an oversized length never reaches the buffer. */
    if (length % 2 != 0 || length > sizeof(payload)) { send_error(client, 0x04); return; }
    if (recv_exact(client, payload, length) < 0) return;

    uint32_t sum = 0;
    for (size_t i = 0; i < length; i += 2) {
        sum += ((uint32_t)payload[i] << 8) | payload[i + 1];
    }
    const unsigned char reply[10] = {
        0x42, 0x42, 0x01, 0x81, 0x00, 0x04,
        (unsigned char)(sum >> 24), (unsigned char)(sum >> 16),
        (unsigned char)(sum >> 8), (unsigned char)sum,
    };
    (void)send_all(client, reply, sizeof(reply));
}

int main(int argc, char **argv) {
    long port = 19006;
    if (argc > 2) {
        fprintf(stderr, "Usage: %s [port]\n", argv[0]);
        return 2;
    }
    if (argc == 2) {
        char *end = NULL;
        errno = 0;
        port = strtol(argv[1], &end, 10);
        if (errno || end == argv[1] || *end || port < 1 || port > 65535) {
            fprintf(stderr, "Port must be an integer from 1 to 65535\n");
            return 2;
        }
    }

    signal(SIGPIPE, SIG_IGN);
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) { perror("socket"); return 1; }
    int reuse = 1;
    if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
        perror("setsockopt"); close(listener); return 1;
    }
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((unsigned short)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0) {
        perror("bind"); close(listener); return 1;
    }
    if (listen(listener, 4) < 0) { perror("listen"); close(listener); return 1; }
    fprintf(stderr, "N06 practice TCP service listening on 127.0.0.1:%ld\n", port);

    for (;;) {
        int client = accept(listener, NULL, NULL);
        if (client < 0 && errno == EINTR) continue;
        if (client < 0) { perror("accept"); close(listener); return 1; }
        handle_request(client);
        close(client);
    }
}
