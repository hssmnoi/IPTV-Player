@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:MENU
cls
echo ==========================================
echo   fetch-fairyanime.js
echo ==========================================
echo.
echo  1. Fetch stream URLs
echo  2. Update metadata (TMDB)
echo  0. Exit
echo.
set "CHOICE="
set /p CHOICE=Select:

if "%CHOICE%"=="1" goto FETCH
if "%CHOICE%"=="2" goto UPDATE
if "%CHOICE%"=="0" goto END
goto MENU

:: ==========================================
:FETCH
cls
echo ==========================================
echo   Fetch Stream URLs
echo ==========================================
echo.
echo  Type:
echo    1 = anime-series (default)
echo    2 = anime-movie
echo    3 = movie
echo    4 = series
echo.
set "TYPE_CHOICE=1"
set /p TYPE_CHOICE=Select type [1]:
if "%TYPE_CHOICE%"=="" set "TYPE_CHOICE=1"
if "%TYPE_CHOICE%"=="1" (set "CTYPE=anime-series") else if "%TYPE_CHOICE%"=="2" (set "CTYPE=anime-movie") else if "%TYPE_CHOICE%"=="3" (set "CTYPE=movie") else if "%TYPE_CHOICE%"=="4" (set "CTYPE=series") else (set "CTYPE=anime-series")
echo.
set "URL="
set /p URL=fairyanime first episode URL (e.g. https://fairyanime.net/watch/ID.html):
if "%URL%"=="" goto FETCH

echo.
echo  Track:
echo    1 = th    (dubbed)
echo    2 = subth (subbed)
echo.
set "TRACK_CHOICE=1"
set /p TRACK_CHOICE=Select track [1]:
if "%TRACK_CHOICE%"=="" set "TRACK_CHOICE=1"
if "%TRACK_CHOICE%"=="1" (set "TRACK=th") else (set "TRACK=subth")

echo.
set "SEASON=1"
set /p SEASON=Season number [1]:
if "%SEASON%"=="" set "SEASON=1"

echo.
set "FNAME="
set /p FNAME=Filename (without .txt, e.g. my-anime):
if "%FNAME%"=="" goto FETCH
set "OUTPUT=%FNAME%.txt"

echo.
set "TMDB_ID="
set /p TMDB_ID=TMDB ID (leave blank = auto):

echo.
set "CMD=node fetch-fairyanime.js %URL% --track=%TRACK% --season=%SEASON% --output=%OUTPUT% --type=%CTYPE%"
if not "%TMDB_ID%"=="" set "CMD=%CMD% --tmdb-id=%TMDB_ID%"

echo  ^ %CMD%
echo.
%CMD%
goto DONE

:: ==========================================
:UPDATE
cls
echo ==========================================
echo   Update Metadata (TMDB)
echo ==========================================
echo.
set "FNAME="
set /p FNAME=Filename (without .txt, e.g. my-anime):
if "%FNAME%"=="" goto UPDATE
set "OUTPUT=%FNAME%.txt"

echo.
echo  Mode:
echo    1 = all    (poster + cover + title)
echo    2 = poster (series/season/track cover image only)
echo    3 = cover  (episode thumbnails only)
echo    4 = title  (episode titles only)
echo.
set "META_CHOICE=1"
set /p META_CHOICE=Select mode [1]:
if "%META_CHOICE%"=="" set "META_CHOICE=1"
if "%META_CHOICE%"=="1" (set "META_MODE=all") else if "%META_CHOICE%"=="2" (set "META_MODE=poster") else if "%META_CHOICE%"=="3" (set "META_MODE=cover") else if "%META_CHOICE%"=="4" (set "META_MODE=title") else (set "META_MODE=all")

echo.
set "SEASON="
set /p SEASON=Season number (leave blank = all seasons):

echo.
echo  Track filter:
echo    0 = all tracks (default)
echo    1 = th    (dubbed only)
echo    2 = subth (subbed only)
echo.
set "TRACK_CHOICE=0"
set /p TRACK_CHOICE=Select track [0]:
if "%TRACK_CHOICE%"=="" set "TRACK_CHOICE=0"
if "%TRACK_CHOICE%"=="1" (set "TRACK_OPT=--track=th") else if "%TRACK_CHOICE%"=="2" (set "TRACK_OPT=--track=subth") else (set "TRACK_OPT=")

echo.
set "CMD=node fetch-fairyanime.js"
if "%META_MODE%"=="all" (set "CMD=%CMD% --update-meta") else (set "CMD=%CMD% --update-meta=%META_MODE%")
if not "%SEASON%"=="" set "CMD=%CMD% --season=%SEASON%"
if not "%TRACK_OPT%"=="" set "CMD=%CMD% %TRACK_OPT%"
set "CMD=%CMD% --output=%OUTPUT%"

echo  ^ %CMD%
echo.
%CMD%
goto DONE

:: ==========================================
:DONE
echo.
echo ==========================================

:AGAIN
echo.
set "AGAIN=n"
set /p AGAIN=Run again? (y/n) [n]:
if /i "%AGAIN%"=="y" goto MENU

:END
endlocal
exit /b 0
