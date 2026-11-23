/**
 * dsh-gitkit — useMenuFetch：「菜单开着即拉数据」观测态样板 hook（Phase 2·client
 * 收敛；GitHeaderButton 的 Agent 工具/自动化两个同形 effect 收敛于此）。
 *
 * 语义逐字节保真：enabled（菜单开）⇒ 每次翻真重取防陈旧；成功 ⇒ value，失败 ⇒
 * null（静默降级——观测行不进错误卡语义）；取消位防迟到解析；关闭不清值（原实现
 * 数据残留，重开重取）。
 */

import { useEffect, useState } from 'react'
import type { RemoteResult } from '../remote/mount.js'

export interface UseMenuFetchInput<T> {
  /** 拉取开关（菜单开着 = true；false→true 边沿重取防陈旧）。 */
  enabled: boolean
  /** 观测态拉取面（face 方法直传——apply 顶层单例闭包，引用稳定）。 */
  fetch: () => Promise<RemoteResult<T>>
}

/** 「开着即拉」观测态：成功 ⇒ value；失败/未拉取 ⇒ null（行缺席）。 */
export function useMenuFetch<T>(input: UseMenuFetchInput<T>): T | null {
  const { enabled, fetch } = input
  const [value, setValue] = useState<T | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetch().then((result) => {
      if (cancelled) return
      setValue(result.ok ? result.value : null)
    })
    return () => { cancelled = true }
  }, [enabled, fetch])

  return value
}
