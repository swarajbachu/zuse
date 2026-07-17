#!/bin/sh

if [ "$1" != "mcp" ] || [ "$2" != "login" ] || [ "$3" != "plugin:figma:figma" ]; then
	echo "unexpected arguments" >&2
	exit 2
fi

if [ ! -t 0 ]; then
	echo "stdin isn't a terminal" >&2
	exit 3
fi

echo "Open this URL to authenticate: https://auth.example.test/authorize?server=figma"
sleep 0.1
echo "Authentication successful"
