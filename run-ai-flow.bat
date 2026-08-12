@echo off
REM =====================================================================
REM  AI Flow launcher
REM
REM  NOTE: keep this file PURE ASCII.
REM  .bat is read with the system ANSI codepage (Thai Windows = CP874),
REM  so UTF-8 Thai text becomes garbage that cmd tries to execute as
REM  commands ("is not recognized as an internal or external command").
REM
REM  Design notes (learned the hard way):
REM   - Do NOT use `timeout` : needs an interactive console, fails silently
REM     when the window starts minimized.
REM   - Do NOT use bare `start http://...` : Internet Explorer hijacks it
REM     even when Firefox is the registered default.
REM   - Do NOT open the browser on a fixed delay : if the server is slow the
REM     page loads before it can bind and shows "unable to connect".
REM     -> we poll the port and only open once it actually answers.
REM   - Do NOT let node write to THIS console window.  (2026-07-31 bug)
REM     Windows consoles have QuickEdit on by default: the moment you click or
REM     drag inside the window, Windows SUSPENDS the writing process at its next
REM     stdout write.  The server logs on every save, so one stray click froze
REM     the whole server - every route timed out, the page looked dead, and
REM     pressing buttons did nothing.  Redirecting output to a log file makes
REM     the server immune to that.
REM =====================================================================
title AI Flow - server (keep this window open)
cd /d "%~dp0"

echo.
echo   ============================================
echo    AI Flow - automation map
echo   ============================================
echo.
echo    KEEP THIS WINDOW OPEN.
echo    Closing it stops the server.
echo.
echo    URL: http://127.0.0.1:7788
echo.
echo    Log: %TEMP%\ai-flow-server.log
echo    (clicking inside this window can no longer freeze the server)
echo.

REM --- already running? just open the page, don't start a second server ---
powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort 7788 -State Listen -EA SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo   [server already running - opening browser]
  call :openpage
  echo.
  echo   You can close this window; the other one is running the server.
  pause
  exit /b
)

REM --- find Firefox (user's default browser) ---
set "FF=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" set "FF=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" set "FF=%LOCALAPPDATA%\Mozilla Firefox\firefox.exe"

REM --- open the browser only AFTER the port answers (max ~20s) ---
start "" /b cmd /c "for /L %%i in (1,1,40) do (powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort 7788 -State Listen -EA SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1 && (if exist "%FF%" ("%FF%" http://127.0.0.1:7788) else (start "" http://127.0.0.1:7788)) && exit) & ping -n 2 127.0.0.1 >nul)"

echo   [starting server...]
echo.
REM stdout/stderr -> log file, NOT this console (see QuickEdit note at top).
node server\index.js > "%TEMP%\ai-flow-server.log" 2>&1

echo.
echo   [server stopped]
echo   If this was not intentional, the reason is at the end of:
echo     %TEMP%\ai-flow-server.log
pause
exit /b

:openpage
if exist "%FF%" (
  start "" "%FF%" http://127.0.0.1:7788
) else (
  start "" http://127.0.0.1:7788
)
exit /b
