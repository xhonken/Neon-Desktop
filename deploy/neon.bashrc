# Neon Desktop shared Bash appearance. Sourced by /etc/bash.bashrc.
# No aliases, history changes, subprocesses, network calls or terminal resets.
[ -n "${BASH_VERSION-}" ] || return
case $- in *i*) ;; *) return ;; esac
(( EUID >= 1000 )) && [[ ${HOME-} == /home/* ]] || return
[[ -t 1 ]] || return
[[ ${_NEON_SHELL_LOADED_PID-} != "$BASHPID" ]] || return
_NEON_SHELL_LOADED_PID=$BASHPID

_neon_shell_prompt() {
    local previous_status=$?
    # Checked at prompt time, after the user's own .bashrc has been read.
    [[ ${NEON_SHELL_THEME-1} != 0 ]] || return "$previous_status"
    local mint='' cyan='' text='' muted='' reset=''
    if [[ -z ${NO_COLOR-} && ${TERM-dumb} != dumb ]]; then
        case ${COLORTERM-}:${TERM-} in
            truecolor:*|24bit:*|*:xterm-256color)
                mint=$'\e[38;2;101;230;173m'
                cyan=$'\e[38;2;103;215;239m'
                text=$'\e[38;2;220;230;235m'
                muted=$'\e[38;2;139;157;169m' ;;
            *:*-256color)
                mint=$'\e[38;5;85m'; cyan=$'\e[38;5;81m'
                text=$'\e[38;5;253m'; muted=$'\e[38;5;246m' ;;
            *)
                mint=$'\e[32m'; cyan=$'\e[36m'
                text=$'\e[37m'; muted=$'\e[90m' ;;
        esac
        reset=$'\e[0m'
    fi
    if [[ ${_NEON_SHELL_BANNER_PID-} != "$BASHPID" ]]; then
        _NEON_SHELL_BANNER_PID=$BASHPID
        if [[ ${NEON_SHELL_BANNER-1} != 0 && ${TERM-dumb} != dumb ]]; then
            printf '\n'
            if (( ${COLUMNS:-80} < 60 )); then
                printf '  %sN%s/  %sNEON DESKTOP%s\n' "$mint" "$cyan" "$text" "$reset"
            else
                printf ' %s   _   __ %s /%s\n' "$mint" "$cyan" "$reset"
                printf ' %s  / | / / %s/    %sNEON DESKTOP%s\n' "$mint" "$cyan" "$text" "$reset"
                printf ' %s /  |/ / %s/     %sYour Linux workspace%s\n' "$mint" "$cyan" "$muted" "$reset"
                printf ' %s/_/|__/ %s/%s\n' "$mint" "$cyan" "$reset"
            fi
            printf '\n'
        fi
    fi
    # Bash expands user/host/path itself. ANSI spans are marked nonprinting so
    # Readline can wrap and edit long commands correctly. Never interpolate PWD.
    PS1="\[${mint}\]"'\u'"\[${muted}\]@\[${text}\]"'\h'"  \[${cyan}\]"'\w'"\[${reset}\]"$'\n'"\[${mint}\]N\[${cyan}\]/\[${muted}\] "'\$'"\[${reset}\] "
    return "$previous_status"
}

# Bash 5 supports an array: keep existing hooks as separate entries, and keep
# the previous command's exit status available to those hooks and the user.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
    PROMPT_COMMAND=(_neon_shell_prompt "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND=(_neon_shell_prompt "${PROMPT_COMMAND-}")
fi
