' ===================================================================
'  Price pass-through SIMULATION launcher (hidden). ASCII ONLY on purpose:
'  a VBS file with non-ASCII bytes can fail to start (wscript reads it as
'  ANSI), so DO NOT add Japanese comments here.
'
'  What it does:
'    - Finds its own folder from WScript.ScriptFullName (no hard-coded path).
'    - Runs "node src\server.js" (port 8765) with window style 0 (fully
'      hidden: no black console window ever appears).
'    - server.js already opens the browser and, being a resident server,
'      keeps running. sim.bat stops any old server on 8765 first so new
'      code always loads.
'
'  NOTE: on Google Drive (G:) a newly created .vbs gets ZoneId=3 and is
'  refused ("no permission"). Launch this through the sibling sim.bat,
'  which unblocks this .vbs first, then runs it hidden.
' ===================================================================
Option Explicit

Dim fso, sh, dir, server, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' Folder that contains this .vbs (works no matter where it is placed)
dir = fso.GetParentFolderName(WScript.ScriptFullName)
server = fso.BuildPath(dir, "src\server.js")

' Run from the project folder so relative paths resolve as expected.
sh.CurrentDirectory = dir

' node <full path to server.js> ; quote the path in case of spaces.
cmd = "node """ & server & """"

' 0 = hidden window, False = do not wait (detach and let node keep running)
sh.Run cmd, 0, False
