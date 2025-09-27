@echo off
echo Starting MCP AL Reviewer Server...
echo.
echo If VS Code is asking to "wait for connection", this should resolve it.
echo Press Ctrl+C to stop the server.
echo.
cd /d "%~dp0"
node index.mjs
pause