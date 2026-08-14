@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

title Claude Desktop MCP Installer
color 0B

echo ============================================================
echo   Claude Desktop MCP - установка всех компонентов
echo ============================================================
echo.

:: ------------------------------------------------------------
:: 0. Проверка прав администратора
:: ------------------------------------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Рекомендуется запускать от имени администратора.
    echo     Некоторые глобальные npm-пакеты могут не установиться.
    echo.
    set /p "cont=Продолжить без прав администратора? (y/n): "
    if /i "!cont!" neq "y" exit /b 1
)
echo.

:: ------------------------------------------------------------
:: 1. Проверка Node.js
:: ------------------------------------------------------------
echo [1/7] Проверка Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Node.js не найден. Установите с https://nodejs.org (18+)
    echo     и перезапустите установку.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo     OK: Node.js !NODE_VERSION!
echo.

:: ------------------------------------------------------------
:: 2. Проверка Python
:: ------------------------------------------------------------
echo [2/7] Проверка Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Python не найден. Установите с https://python.org (3.9+)
    echo     Не забудьте поставить галочку "Add to PATH".
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do set "PY_VERSION=%%v"
echo     OK: !PY_VERSION!
echo.

:: ------------------------------------------------------------
:: 3. Установка глобальных npm-пакетов
:: ------------------------------------------------------------
echo [3/7] Установка npm-пакетов (может занять несколько минут)...

call :npm_install "@modelcontextprotocol/server-memory"
call :npm_install "@modelcontextprotocol/server-filesystem"
call :npm_install "@modelcontextprotocol/server-sequential-thinking"
call :npm_install "@modelcontextprotocol/server-puppeteer"
call :npm_install "chrome-devtools-mcp@latest"
call :npm_install "@calibress/curl-mcp"
call :npm_install "@alolite/ssh-mcp"
call :npm_install "tavily-mcp@latest"
call :npm_install "ssh-mcp"
call :npm_install "mcp-gsheets@latest"
call :npm_install "@gongrzhe/server-gmail-autoauth-mcp"
call :npm_install "@playwright/mcp@latest"
echo.

:: ------------------------------------------------------------
:: 4. Установка Python-пакетов
:: ------------------------------------------------------------
echo [4/7] Установка Python-пакетов...
python -m pip install --upgrade pip
python -m pip install mcp-server-fetch
python -m pip install "litellm[proxy]"
echo.

:: ------------------------------------------------------------
:: 5. Создание папок и копирование memory-proxy
:: ------------------------------------------------------------
echo [5/7] Создание папок и копирование файлов...
if not exist "%USERPROFILE%\.claude\mcp" mkdir "%USERPROFILE%\.claude\mcp"
if not exist "%USERPROFILE%\.claude\skills" mkdir "%USERPROFILE%\.claude\skills"
if exist "%~dp0memory-proxy.cjs" copy /Y "%~dp0memory-proxy.cjs" "%USERPROFILE%\.claude\mcp\memory-proxy.cjs" >nul
echo     OK: папки созданы, memory-proxy.cjs скопирован
echo.

:: ------------------------------------------------------------
:: 6. Локальный web-search сервер
:: ------------------------------------------------------------
echo [6/7] Настройка локального web-search сервера...
if not exist "%USERPROFILE%\web-search" mkdir "%USERPROFILE%\web-search"
if exist "%~dp0web-search\index.js" copy /Y "%~dp0web-search\index.js" "%USERPROFILE%\web-search\index.js" >nul
if exist "%~dp0web-search\package.json" copy /Y "%~dp0web-search\package.json" "%USERPROFILE%\web-search\package.json" >nul
pushd "%USERPROFILE%\web-search"
call npm install
popd
echo.

:: ------------------------------------------------------------
:: 7. Генерация конфига
:: ------------------------------------------------------------
echo [7/7] Запуск генератора конфига...
if exist "%~dp0setup-config.ps1" (
    powershell -ExecutionPolicy Bypass -File "%~dp0setup-config.ps1"
) else (
    echo [X] setup-config.ps1 не найден. Создайте claude_desktop_config.json вручную.
)
echo.

echo ============================================================
echo   Готово! Перезапустите Claude Desktop.
echo   Если что-то пошло не так - смотрите README.md (раздел FAQ).
echo ============================================================
pause
exit /b 0

:: ------------------------------------------------------------
:: Подпрограмма: установка npm-пакета
:: ------------------------------------------------------------
:npm_install
echo     Установка: %~1
call npm install -g "%~1" >nul 2>&1
if %errorlevel% equ 0 (
    echo         OK
) else (
    echo         [WARN] Ошибка установки %~1
)
exit /b 0
