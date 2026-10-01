/* Small PAM helper. Credentials on stdin only; never command line or logs. */
#include <security/pam_appl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static char password[1025];
static int converse(int n, const struct pam_message **msg, struct pam_response **out, void *data) {
    (void)data;
    if (n < 1 || n > 16) return PAM_CONV_ERR;
    struct pam_response *r = calloc(n, sizeof(*r));
    if (!r) return PAM_BUF_ERR;
    for (int i=0; i<n; i++) {
        if (msg[i]->msg_style == PAM_PROMPT_ECHO_OFF) r[i].resp = strdup(password);
        else if (msg[i]->msg_style != PAM_TEXT_INFO && msg[i]->msg_style != PAM_ERROR_MSG) {
            for(int j=0;j<i;j++) { free(r[j].resp); }
            free(r); return PAM_CONV_ERR;
        }
    }
    *out = r; return PAM_SUCCESS;
}
int main(void) {
    char user[257]; pam_handle_t *p = NULL;
    alarm(15);
    if (!fgets(user,sizeof(user),stdin) || !fgets(password,sizeof(password),stdin)) return 1;
    user[strcspn(user,"\n")] = 0; password[strcspn(password,"\n")] = 0;
    struct pam_conv c = {converse, NULL};
    int result = pam_start("neon-desktop",user,&c,&p);
    if (result == PAM_SUCCESS) result = pam_authenticate(p, PAM_DISALLOW_NULL_AUTHTOK);
    if (result == PAM_SUCCESS) result = pam_acct_mgmt(p, 0);
    explicit_bzero(password,sizeof(password));
    if (p) pam_end(p,result);
    return result == PAM_SUCCESS ? 0 : 1;
}
