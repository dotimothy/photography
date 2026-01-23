@echo off
setlocal enabledelayedexpansion

:: ==========================================
:: Configuration
:: ==========================================
set "PYTHON=python"
set "SCRIPT=preparePortfolio.py"
set "BUILD_DIR=build"
set "VENV=.venv"
set "VENV_PYTHON=%VENV%\Scripts\python.exe"

:: ------------------------------------------
:: Default Values
:: ------------------------------------------
set "quality=60"
set "jobs=0"
set "target=build"
set "target_specified=false"

:: ==========================================
:: Robust Argument Parsing
:: ==========================================
:parse_args
if "%~1"=="" goto :execute_target

set "arg=%~1"

:: 1. Handle "jobs=8" format (CMD standard)
if /i "%arg:~0,5%"=="jobs=" (
    set "jobs=%arg:~5%"
    shift
    goto :parse_args
)
if /i "%arg:~0,8%"=="quality=" (
    set "quality=%arg:~8%"
    shift
    goto :parse_args
)

:: 2. Handle "jobs 8" format (PowerShell splitting)
if /i "%arg%"=="jobs" (
    set "jobs=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%arg%"=="quality" (
    set "quality=%~2"
    shift
    shift
    goto :parse_args
)

:: 3. Handle Targets (build, clean, etc.)
:: If we haven't matched a variable above, assume it's the target.
set "target=%arg%"
set "target_specified=true"
shift
goto :parse_args

:: ==========================================
:: Execution Router
:: ==========================================
:execute_target

if /i "%target%"=="all"       goto :all
if /i "%target%"=="build"     goto :build
if /i "%target%"=="install"   goto :install
if /i "%target%"=="fast"      goto :fast
if /i "%target%"=="exif"      goto :exif
if /i "%target%"=="clean"     goto :clean
if /i "%target%"=="deepclean" goto :deepclean
if /i "%target%"=="help"      goto :help

:: If target is unknown
echo Unknown target: %target%
goto :help

:: ==========================================
:: Targets
:: ==========================================

:all
call :deepclean
call :build
goto :eof

:install
if exist "%VENV%\Scripts\activate.bat" goto :eof
echo Creating virtual environment...
if not exist "%VENV%" %PYTHON% -m venv %VENV%
"%VENV_PYTHON%" -m pip install --upgrade pip >nul
"%VENV_PYTHON%" -m pip install -r requirements.txt >nul
copy /b "%VENV%\Scripts\activate.bat" +,, >nul 2>&1
goto :eof

:build
call :install
"%VENV_PYTHON%" %SCRIPT% --watermark --full-clean --quality %quality% --jobs %jobs%
goto :eof

:fast
call :install
"%VENV_PYTHON%" %SCRIPT% --skip-repo --quality %quality% --jobs %jobs%
goto :eof

:exif
call :install
"%VENV_PYTHON%" %SCRIPT% --exif
goto :eof

:clean
if exist "%BUILD_DIR%" rd /s /q "%BUILD_DIR%"
goto :eof

:deepclean
call :clean
if exist "%VENV%" rd /s /q "%VENV%"
if exist ".cache" rd /s /q ".cache"
if exist "tmp" rd /s /q "tmp"
if exist "logs" rd /s /q "logs"
goto :eof

:help
echo TheDoShoots Portfolio Makefile
echo ------------------------------------------
echo Usage: make [target] quality=[value] jobs=[value]
echo.
echo Options:
echo   quality=[0-100] : Set JPEG quality (default 60)
echo   jobs=[num]      : Set number of CPU cores (default 0 = all)
echo.
echo Targets:
echo   install   - Create venv and install dependencies
echo   build     - Run full build (Default)
echo   fast      - Run build without watermarking or git updates
echo   clean     - Remove build directory
echo   deepclean - Remove venv, logs folder, build dir, and cache
goto :eof