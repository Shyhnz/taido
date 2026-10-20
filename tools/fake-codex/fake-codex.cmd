@ECHO off
REM Windows launcher of fake-codex for the tests, in the form npm writes (cmd-shim):
REM Taido runs the script with node directly, as for an agent installed with npm.
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
endLocal & "node" "%dp0%\fake-codex" %*
