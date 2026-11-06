# 从 Windows 凭据管理器读取 git 的 GitHub 凭据（只读，不落盘）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GitCredReader {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  public static string Get(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    var c = Marshal.PtrToStructure<CREDENTIAL>(p);
    string blob = "";
    if (c.CredentialBlobSize > 0 && c.CredentialBlob != IntPtr.Zero) {
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      blob = System.Text.Encoding.Unicode.GetString(b).TrimEnd('\0');
    }
    CredFree(p);
    return c.UserName + "|" + blob;
  }
}
"@
$raw = [GitCredReader]::Get('git:https://github.com')
if (-not $raw) { throw '读取 GitHub 凭据失败' }
return ($raw -split '\|', 2)[1]