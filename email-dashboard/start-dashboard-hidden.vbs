' Starts the email dashboard with no visible window.
' To stop it later: Task Manager -> find "Node.js" -> End task.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.js", 0, False
