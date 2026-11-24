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
afficher_et_ouvrir() {
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ "$line" == "Copeau prêt : http://127.0.0.1:"* ]]; then
      url=${line#* : }
      if ! "$opener" "$url" </dev/null; then
        printf 'Ouvrez %s dans votre navigateur.\n' "$url" >&2
      fi
    fi
  done
}
# N'ouvrir le navigateur qu'après la confirmation d'écoute de notre propre serveur.
exec ./copeau-rust --server > >(afficher_et_ouvrir)
