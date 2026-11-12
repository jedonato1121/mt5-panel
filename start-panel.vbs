' Starts the MT5 panel server from this folder, without a visible console.
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c cd /d """ & here & """ && node server\index.js", 0, False
