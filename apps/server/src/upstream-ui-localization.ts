export const UPSTREAM_UI_TRANSLATIONS: Readonly<Record<string, string>> = Object.freeze({
  "New chat": "新建聊天", "New Chat": "新建聊天",
  "Search chats": "搜索聊天", "Search chats...": "搜索聊天…", "Search conversations...": "搜索会话…", "Search": "搜索",
  "Explore GPTs": "探索 GPT", "GPTs": "GPT", "Library": "资料库", "Projects": "项目", "Your chats": "你的聊天",
  "Today": "今天", "Yesterday": "昨天", "Previous 7 days": "过去 7 天", "Previous 30 days": "过去 30 天",
  "Settings": "设置", "Help": "帮助", "Log out": "退出登录", "Log in": "登录", "Sign up": "注册",
  "Sign up for free": "免费注册", "Create account": "创建账号", "Upgrade plan": "升级套餐", "Upgrade": "升级",
  "Temporary chat": "临时聊天", "Temporary Chat": "临时聊天", "Temporary": "临时",
  "Share": "分享", "Copy link": "复制链接", "Copy": "复制", "Copied!": "已复制！", "Edit": "编辑", "Delete": "删除",
  "Rename": "重命名", "Archive": "归档", "Unarchive": "取消归档", "Report": "举报", "Regenerate": "重新生成",
  "Retry": "重试", "Stop generating": "停止生成", "Read aloud": "朗读", "Good response": "好评", "Bad response": "差评",
  "More actions": "更多操作", "More options": "更多选项", "Attach files": "添加文件",
  "Add photos & files": "添加照片和文件", "Add photos and files": "添加照片和文件",
  "Upload from computer": "从电脑上传", "Take a screenshot": "截取屏幕", "Search the web": "搜索网页",
  "Deep research": "深度研究", "Create image": "创建图像", "Voice": "语音", "Start voice": "开始语音",
  "Start voice chat": "开始语音对话", "Start dictation": "开始听写", "Send": "发送", "Cancel": "取消", "Save": "保存",
  "Done": "完成", "Close": "关闭", "Continue": "继续", "Try again": "重试", "Show more": "显示更多",
  "Show less": "收起", "Open sidebar": "展开侧边栏", "Close sidebar": "收起侧边栏", "Open menu": "打开菜单",
  "Close menu": "关闭菜单", "More": "更多", "Loading...": "加载中…", "Thinking...": "思考中…",
  "Searching the web...": "正在搜索网页…", "Analyzing...": "正在分析…", "Working...": "处理中…", "Generating...": "正在生成…",
  "Something went wrong": "发生错误", "An error occurred": "发生错误", "Failed to send message": "消息发送失败",
  "There was an error generating a response": "生成回复时发生错误", "Connection lost. Reconnecting...": "连接已断开，正在重新连接…",
  "Reconnecting...": "正在重新连接…", "Network error": "网络错误", "Try again later": "请稍后重试",
  "Message ChatGPT": "发送消息给 ChatGPT", "Ask anything": "输入你的问题", "Message...": "输入消息…",
  "Send a message": "发送消息", "Ask a follow-up": "继续提问", "Write a message": "输入消息", "Drop files here": "将文件拖放到此处",
  "Uploading...": "正在上传…", "Uploading": "正在上传", "Upload failed": "上传失败", "Failed to upload file": "文件上传失败",
  "File upload failed": "文件上传失败", "File too large": "文件过大", "Unsupported file type": "不支持的文件类型",
  "Remove file": "移除文件", "Remove attachment": "移除附件", "Download": "下载", "Download file": "下载文件",
  "Copied to clipboard": "已复制到剪贴板", "Copy to clipboard": "复制到剪贴板", "Edit message": "编辑消息",
  "Delete message": "删除消息", "Delete chat": "删除聊天", "Archive chat": "归档聊天", "Share conversation": "分享会话",
  "Copy conversation link": "复制会话链接", "Branch in new chat": "在新聊天中分支", "Open in new window": "在新窗口中打开",
  "Open in new tab": "在新标签页中打开", "Pin chat": "固定聊天", "Unpin chat": "取消固定", "Move to project": "移动到项目",
  "Add to project": "添加到项目", "Create project": "创建项目", "New project": "新建项目", "View all": "查看全部",
  "Upgrade to Plus": "升级至 Plus", "Upgrade to Pro": "升级至 Pro", "Manage subscription": "管理订阅",
  "Keyboard shortcuts": "键盘快捷键", "What's new": "最新动态", "Release notes": "更新说明", "Voice mode": "语音模式",
  "End call": "结束通话", "Stop sharing": "停止共享", "Share screen": "共享屏幕", "Enable camera": "开启摄像头",
  "Enable microphone": "开启麦克风", "Turn on microphone": "开启麦克风", "Turn off microphone": "关闭麦克风",
  "Mute": "静音", "Unmute": "取消静音", "Camera": "摄像头", "Microphone": "麦克风", "Select a model": "选择模型",
  "Auto": "自动", "Fast": "快速", "Instant": "即时", "Tools": "工具", "Add more": "添加更多", "Select files": "选择文件",
  "Choose files": "选择文件", "Upload files": "上传文件", "Add files": "添加文件", "No files selected": "未选择文件",
  "Remove from sidebar": "从侧边栏移除", "Settings and beta": "设置与测试版", "Help & FAQ": "帮助与常见问题",
  "Terms": "服务条款", "Privacy": "隐私", "Stop": "停止", "Continue generating": "继续生成",
  "Show reasoning": "显示推理过程", "Hide reasoning": "隐藏推理过程", "Sources": "来源", "Citations": "引用"
});

export function translateUpstreamUiText(
  value: string,
  translations: Readonly<Record<string, string>> = UPSTREAM_UI_TRANSLATIONS,
): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;

  if (Object.prototype.hasOwnProperty.call(translations, normalized)) {
    return translations[normalized];
  }

  // Upstream upload toasts may include a file name, so exact dictionary
  // entries alone are insufficient. Keep these patterns deliberately narrow
  // and only translate known upload failure/size/type messages.
  if (/^(?:failed to upload|couldn['’]t upload|could not upload|unable to upload|we couldn['’]t upload|we could not upload)(?: the| your)? (?:file|image)(?:\s*[:：-]\s*.+)?(?:[.!])?$/i.test(normalized)
    || /^(?:upload failed|file upload failed|image upload failed)(?:[.!]?\s*(?:please )?try again[.!]?)?$/i.test(normalized)
    || /^(?:something went wrong|there was (?:a|an) (?:problem|error)) (?:while|when) uploading(?: the| your)? (?:file|image)(?:\s*[:：-]\s*.+)?(?:[.!])?$/i.test(normalized)) {
    return "文件上传失败，请重试。";
  }

  if (/^(?:this )?(?:file|image) is too large(?:[.!]?\s*(?:please )?try again[.!]?)?$/i.test(normalized)) {
    return "文件过大，请缩小文件后重试。";
  }

  if (/^(?:unsupported|不支持的) (?:file|image) type(?:[.!]?\s*(?:please )?try again[.!]?)?$/i.test(normalized)
    || /^this file type is not supported[.!]?$/i.test(normalized)) {
    return "不支持此文件类型，请选择其他文件。";
  }

  return undefined;
}
