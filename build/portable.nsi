# ---------------------------------------------------------------------------
# 便携版启动器模板（本项目定制，基于 electron-builder 26.x 的 portable.nsi）
#
# 为什么要有这个文件：
#   原版模板每次双击都做 RMDir /r + 全量解压，实测约 10 秒。
#   这段时间里 Electron 还没启动，src/splash.html 的加载动画物理上不可能显示，
#   用户看到的就是「一片空白，什么都没发生」。
#
#   本模板的改动：
#     1) 不再显示静态 splash 图——它只能干等着，不能动，正是要去掉的东西
#     2) 解压结果缓存在固定目录，并写入「版本 + 构建戳」；
#        戳一致就跳过解压，直接启动 Electron
#
# 效果（实测）：
#   首次启动约 10.6 秒（文件必须真的落盘一次，静默等待，无窗口）
#   之后每次双击约 214ms 进入动画
#
# 几个必须守住的约束：
#   a) 缓存有效时绝不能碰任何文件——否则会删掉正在运行的程序
#   b) 结束时不能删解压目录——原版「用完即走」会让缓存永远建立不起来
#   c) 只用 $R5 之后的寄存器——extractUsing7za 内部占用了 $R0/$R1
#   d) 戳里必须带构建戳而不只是版本号，否则改了代码却没升版本时会跑旧缓存
#
# 维护提示：
#   electron-builder 的 portable 目标不接受自定义脚本（NsisTarget 里写死读模板），
#   所以由 tools/patch-portable-nsi.mjs 在打包前把本文件覆盖到模板目录，
#   同时把 @@CACHE_STAMP@@ 换成当次构建的指纹。
# ---------------------------------------------------------------------------
!include "common.nsh"
!include "extractAppPackage.nsh"
!include "LogicLib.nsh"

# 由 patch-portable-nsi.mjs 在打包时替换成真实指纹（源码内容哈希）
!define CACHE_STAMP "@@CACHE_STAMP@@"

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Function .onInit
  # 没有静态图可看，就不该弹任何 NSIS 窗口；解压期间只剩系统的忙碌光标
  SetSilent silent
  !insertmacro check64BitAndSetRegView
FunctionEnd

Section
  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    # 缓存目录放在 LOCALAPPDATA 而不是 TEMP：
    # TEMP 会被磁盘清理/系统维护随手删掉，缓存白建，下次又要等 10 秒。
    # LOCALAPPDATA 属于用户数据区，不会被当成垃圾清理。
    StrCpy $INSTDIR "$LOCALAPPDATA\${UNPACK_DIR_NAME}"
  !endif

  # -------------------------------------------------------------------------
  # 缓存判定：asar 在、戳文件在、且戳内容与本次构建一致 → 直接复用
  # -------------------------------------------------------------------------
  StrCpy $R5 "0"                                    # $R5=1 表示本次走的是缓存

  IfFileExists "$INSTDIR\resources\app.asar" 0 do_extract
  IfFileExists "$INSTDIR\.unpack-stamp" 0 do_extract
    ClearErrors
    FileOpen $R6 "$INSTDIR\.unpack-stamp" r
    FileRead $R6 $R7
    FileClose $R6
    # 戳 = 版本 + 构建指纹；两者任一变化都要重新解压
    StrCmp $R7 "${VERSION}-${CACHE_STAMP}" 0 do_extract
      StrCpy $R5 "1"
      Goto extract_done

  do_extract:
    # ---------------------------------------------------------------------
    # 先确认旧缓存没被占用，再动文件。
    #
    # 缓存目录固定之后这条变得关键：用户开着程序又双击 exe 时，
    # 直接 RMDir /r 删不掉正在运行的 Electron（文件被占用），
    # 会留下半套文件、程序也起不来。
    #
    # 检测用「重命名」而不是 nsProcess 插件：被占用的文件无法重命名，
    # 重命名成功就说明没人占用。零插件依赖——electron-builder 的 NSIS
    # 目录里没有 nsProcess，引用它会让编译直接失败。
    # ---------------------------------------------------------------------

    # 首次启动时缓存目录根本不存在，不必等
    IfFileExists "$INSTDIR\*.*" 0 cache_freed

    # 上次被打断可能留下 .old，先清掉，否则重命名会因同名失败
    RMDir /r "$INSTDIR.old"

    StrCpy $R8 "0"
    try_free_cache:
      ClearErrors
      Rename "$INSTDIR" "$INSTDIR.old"
      IfErrors 0 renamed_ok

      # 改名失败：有实例占用。给旧实例一点时间响应单实例信号后自行退出
      IntOp $R8 $R8 + 1
      ${If} $R8 >= 24
        # 等满一分钟仍被占用，说明程序确实开着且没退出。
        # 此时绝不能硬删，否则会把用户正在用的文件删坏。
        MessageBox MB_OK|MB_ICONEXCLAMATION "请先关闭正在运行的「${PRODUCT_NAME}」，再重新双击启动。"
        Quit
      ${EndIf}
      Sleep 500
      Goto try_free_cache

    renamed_ok:
      RMDir /r "$INSTDIR.old"

    cache_freed:
    RMDir /r $INSTDIR
    SetOutPath $INSTDIR

    !ifdef APP_DIR_64
      !ifdef APP_DIR_ARM64
        !ifdef APP_DIR_32
          ${if} ${IsNativeARM64}
            File /r "${APP_DIR_ARM64}\*.*"
          ${elseif} ${RunningX64}
            File /r "${APP_DIR_64}\*.*"
          ${else}
            File /r "${APP_DIR_32}\*.*"
          ${endIf}
        !else
          ${if} ${IsNativeARM64}
            File /r "${APP_DIR_ARM64}\*.*"
          ${else}
            File /r "${APP_DIR_64}\*.*"
          {endIf}
        !endif
      !else
        !ifdef APP_DIR_32
          ${if} ${RunningX64}
            File /r "${APP_DIR_64}\*.*"
          ${else}
            File /r "${APP_DIR_32}\*.*"
          ${endIf}
        !else
          File /r "${APP_DIR_64}\*.*"
        !endif
      !endif
    !else
      !ifdef APP_DIR_32
        File /r "${APP_DIR_32}\*.*"
      !else
        !insertmacro extractEmbeddedAppPackage
      !endif
    !endif

    # 戳文件：下次启动据此判断能否直接复用
    FileOpen $R6 "$INSTDIR\.unpack-stamp" w
    FileWrite $R6 "${VERSION}-${CACHE_STAMP}"
    FileClose $R6

  extract_done:
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
    ${StdUtils.GetAllParameters} $R0 0

    ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
    SetErrorLevel $0
    SetOutPath $EXEDIR

    # 刻意不删 $INSTDIR：删了缓存就白建，下次又得等 10 秒。
    # 缓存由下次戳变化时（do_extract 开头）自动清理。
SectionEnd
