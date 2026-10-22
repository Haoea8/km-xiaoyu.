@echo off
rem ===============================================================
rem  KEEP THIS FILE ASCII-ONLY. Do not add Chinese text here.
rem
rem  Why: cmd.exe re-reads a .cmd file BY BYTE OFFSET after each
rem  command. UTF-8 multibyte text (Chinese) desyncs that offset, so
rem  the tail of a line gets executed as a command and the window
rem  floods with "'xx' is not recognized as an internal or external
rem  command" -- the service still starts, which makes it easy to
rem  dismiss as "random". (Real accident: 2026-10-17.)
rem
rem  All user-facing text lives in tools\start-admin.js (Node, UTF-8,
rem  rendered fine thanks to chcp 65001 below).
rem  .gitattributes pins *.cmd to CRLF for the same class of reason.
rem ===============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

node tools\start-admin.js
goto END

:NO_NODE
echo.
echo   [ERROR] Node.js was not found in PATH.
echo   Install the LTS build from https://nodejs.org/ and run this file again.
echo.

:END
pause
