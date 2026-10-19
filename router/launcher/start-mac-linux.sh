#!/bin/sh
# Portable start (needs the .NET 8 runtime). On a Mac the standalone .app from the releases needs nothing.
cd "$(dirname "$0")"
for d in "$(command -v dotnet)" /usr/local/share/dotnet/dotnet /usr/local/bin/dotnet /opt/homebrew/bin/dotnet "$HOME/.dotnet/dotnet"; do
  [ -n "$d" ] && [ -x "$d" ] && exec "$d" StockwerkMatrixRouter.dll "$@"
done
echo "Die .NET 8 Runtime wurde nicht gefunden: https://dotnet.microsoft.com/download/dotnet/8.0"
echo "Auf dem Mac geht es ohne .NET mit der Mac-App aus den Releases (Apple Silicon oder Intel)."
exit 1
