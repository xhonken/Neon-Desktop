/* Unprivileged controlling-terminal setup; never setuid, never invokes a shell parser.
 * Called via subprocess's C-level fork/exec to avoid Python work after a threaded fork.
 */
#include <sys/ioctl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc < 2 || getuid() == 0) return 64;
    if (ioctl(STDIN_FILENO, TIOCSCTTY, 0) != 0) {
        perror("controlling terminal"); return 1;
    }
    execv(argv[1], argv + 1);
    perror("terminal executable"); return 1;
}
