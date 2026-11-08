/* N02/N06 original client for the practice SUM protocol. Not the hidden experiment service. */
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
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

static void usage(const char *program) {
    fprintf(stderr, "Usage: %s <port> <n1> [n2 ... n32]\n", program);
}

static int parse_long(const char *text, long low, long high, long *value) {
    char *end = NULL;
    errno = 0;
    *value = strtol(text, &end, 10);
    return errno == 0 && end != text && *end == '\0' && *value >= low && *value <= high;
}

int main(int argc, char **argv) {
    long port = 0;
    if (argc < 3 || argc > 33 || !parse_long(argv[1], 1, 65535, &port)) {
        usage(argv[0]);
        return 2;
    }

    unsigned char request[6 + 64];
    size_t count = (size_t)(argc - 2);
    for (size_t i = 0; i < count; i++) {
        long number = 0;
        if (!parse_long(argv[i + 2], 0, 65535, &number)) {
            usage(argv[0]);
            return 2;
        }
        request[6 + 2 * i] = (unsigned char)(number >> 8);
        request[6 + 2 * i + 1] = (unsigned char)number;
    }
    const size_t payload_length = 2 * count;
    const unsigned char header[6] = {0x42, 0x42, 0x01, 0x01,
        (unsigned char)(payload_length >> 8), (unsigned char)payload_length};
    memcpy(request, header, sizeof(header));

    signal(SIGPIPE, SIG_IGN);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return 1; }
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((unsigned short)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        fprintf(stderr, "connect failed: %s\n", strerror(errno));
        close(fd);
        return 1;
    }
    if (send_all(fd, request, sizeof(header) + payload_length) < 0) {
        fprintf(stderr, "send failed\n");
        close(fd);
        return 1;
    }

    /* The server closes after one reply; a reply longer than 64 bytes is not ours. */
    unsigned char reply[65];
    size_t used = 0;
    for (;;) {
        ssize_t received = recv(fd, reply + used, sizeof(reply) - used, 0);
        if (received < 0 && errno == EINTR) continue;
        if (received < 0) { perror("recv"); close(fd); return 1; }
        if (received == 0) break;
        used += (size_t)received;
        if (used > 64) break;
    }
    close(fd);

    const unsigned char sum_prefix[6] = {0x42, 0x42, 0x01, 0x81, 0x00, 0x04};
    const unsigned char error_prefix[6] = {0x42, 0x42, 0x01, 0xFF, 0x00, 0x01};
    if (used == 10 && memcmp(reply, sum_prefix, sizeof(sum_prefix)) == 0) {
        unsigned long sum = ((unsigned long)reply[6] << 24) | ((unsigned long)reply[7] << 16)
            | ((unsigned long)reply[8] << 8) | reply[9];
        printf("sum=%lu\n", sum);
        return 0;
    }
    if (used == 7 && memcmp(reply, error_prefix, sizeof(error_prefix)) == 0) {
        fprintf(stderr, "error=%u\n", (unsigned)reply[6]);
        return 1;
    }
    fprintf(stderr, "unexpected response (%zu bytes)\n", used);
    return 1;
}
