/**
 * fluent-ffmpeg 默认只在 PATH 中查找二进制；通过 @ffmpeg-installer 随项目提供 ffmpeg/ffprobe，
 * 也可用环境变量 FFMPEG_PATH / FFPROBE_PATH 覆盖（例如使用本机 brew 安装版本）。
 */
import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'

const ffmpegPath = process.env.FFMPEG_PATH?.trim() || ffmpegInstaller.path
const ffprobePath = process.env.FFPROBE_PATH?.trim() || ffprobeInstaller.path

ffmpeg.setFfmpegPath(ffmpegPath)
ffmpeg.setFfprobePath(ffprobePath)

export function getResolvedFfmpegPath(): string {
  return ffmpegPath
}
