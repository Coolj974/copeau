#!/bin/bash
set -eu
cd -- "$(dirname -- "$0")"
export HOST=127.0.0.1 PORT="${PORT:-8000}"

case "$(uname -s)" in
  Darwin) opener=open ;;
  Linux) opener=xdg-open ;;
  *) echo "Ce lanceur est prévu pour Linux ou macOS." >&2; exit 1 ;;
esac

echo "Pour quitter : arrêtez l'usinage, puis appuyez sur Ctrl+C dans ce terminal."
# N'ouvrir le navigateur qu'après la confirmation d'écoute de notre propre serveur.
exec ./copeau-rust --server > >(
  while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      "Copeau prêt : http://127.0.0.1:"*)
        url=${line#* : }
        if ! "$opener" "$url" </dev/null; then
          printf 'Ouvrez %s dans votre navigateur.\n' "$url" >&2
        fi ;;
    esac
  done
)
