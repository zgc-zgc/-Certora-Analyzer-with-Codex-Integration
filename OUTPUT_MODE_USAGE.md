# 输出优化说明

## 功能概述

服务器已优化输出流程，解决了"进程结束但输出仍在缓慢显示"的问题。

## 优化后的行为

### SSE 端点 (`/analyze-rule-stream`)

1. **进程运行时**：
   - 正常流式输出，实时显示分析过程
   - 通过缓冲机制（300ms或12KB）批量发送，优化性能

2. **进程结束时**：
   - 立即停止所有流式输出
   - 清空所有缓冲区（不再发送）
   - 直接发送提取的最终答案（`final` 事件）
   - 用户立即看到分析结论

### WebSocket 端点

1. **进程运行时**：
   - 实时发送输出消息
   - 用户可以监控分析进度

2. **进程结束时**：
   - 直接发送 `complete` 消息，包含提取的最终答案
   - 不会有延迟或"滴答式"输出

## 关键改进

### 1. 智能答案提取
`extractCodexAnswer` 函数会从完整输出中智能提取最终答案：
- 过滤系统元数据（时间戳、进程信息等）
- 定位实际的分析结论
- 返回清晰的最终答案

### 2. 缓冲区管理
进程结束时：
- 清除所有定时器
- 清空缓冲区内容（不发送）
- 避免网络延迟导致的持续输出

### 3. 前端处理建议

收到 `final` 事件时：
```javascript
// SSE 处理
eventSource.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'final') {
    // 清空或隐藏流式输出区域
    clearStreamingOutput();
    // 显示最终答案
    displayFinalAnswer(data.message);
  } else if (data.type === 'output') {
    // 正常追加流式输出
    appendStreamingOutput(data.message);
  }
});

// WebSocket 处理
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'complete' && data.success) {
    // 显示最终答案
    displayFinalAnswer(data.result);
  }
};
```

## 效果对比

### 优化前
- 进程结束后，缓冲区内容继续"滴答式"传输
- 用户需要等待所有内容传输完成
- 最终答案被淹没在大量日志中

### 优化后
- 进程结束时立即停止流式输出
- 直接显示提取的最终答案
- 用户体验：快速、清晰、高效

## 使用场景

这种优化特别适合：
- 长时间运行的分析任务
- 网络连接不稳定的环境
- 需要快速获取分析结论的场景
- 日志量很大但只关心最终结果的情况

## 注意事项

1. **完整日志保存**：虽然前端只显示最终答案，但服务器端仍保留了完整日志（通过 `tailChunks`）
2. **内存限制**：服务器端限制累积日志最大 2MB（`MAX_TAIL_BYTES`）
3. **错误处理**：进程异常退出时会发送错误消息而非最终答案