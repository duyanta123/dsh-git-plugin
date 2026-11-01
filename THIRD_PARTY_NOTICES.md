# THIRD_PARTY_NOTICES — dsh-git-plugin

本文件按 `research/capability-spec.md` §5.2 落地（2026-11-01 定稿；§0.4-8 的 dsh LICENSE
版权行原文已核实——`packages/typert-protocol/LICENSE` 副本 `Copyright (c) 2026 DeepSeek`）。
行级移植登记的权威 = `NOTICE.md` §2 与 `PORTING.md`；来源版本、抓取凭证与逐文件字节校验 =
`research/ported-sources/SOURCES.md`。本文件不携带任何第三方代码文本，只附许可全文与署名行。

## 1. 本项目

dsh-git-plugin 以 **Apache License 2.0** 分发：`Copyright 2026 dsh-git-plugin contributors`。
全文见根目录 `LICENSE`（各包内为同文副本）。移植进本仓库的第三方文件仍保留其**来源许可**
（Apache-2.0 来源逐段移植文件带 `Ported from` 头 + Modifications 行；MIT 来源按其原文署名保留），
本项目的 Apache-2.0 授权不改变第三方材料的许可与署名（Apache-2.0 第 4(c) 条义务照行）。

> 版本注记（2026-11-01 发布定稿）：spec §5.2 原计划「本项目 MIT」；发布 ask 改定为
> **Apache-2.0**（本项目内 Apache-2.0 移植面最大，专利授权条款随许可一并传导）。
> 如需改回 MIT，是一次 LICENSE/NOTICE/THIRD_PARTY_NOTICES/package.json license 字段替换。

## 2. Apache License 2.0 下的第三方材料

以下项目的材料按 Apache-2.0 进入本仓库（移植/对照行见 NOTICE.md §2 / PORTING.md；逐段移植
文件均带 `Ported from` 文件头 + Modifications 变更说明——Apache-2.0 第 4 条署名义务）。
许可全文见本文件第 4 节。

| 来源项目 | 版权与署名行（其 LICENSE 原文） | 抓取版本 | 本仓库落点（登记行摘要） |
|---|---|---|---|
| zai-org/ZCode | `Copyright 2026 Z.AI Co., Ltd` | `3c5b227649371507ddc4eb46ac5133afe6db1cab` | host `status.ts` / `status-parser.ts` / `mutations.ts` / `commit.ts` / `message-gen.ts` / `watcher.ts` / `graph.ts`；client `ChangeCard.tsx` 等交互对照（C 级） |
| openai/codex | `Copyright 2025 OpenAI` | `7c11b8074dbdbab2a3afedf30df7c55f0c6907d8` | host `git-runner.ts`（`safe.bareRepository` 参数清单翻译；Rust 源码未移植） |
| cline/cline | `Copyright 2026 Cline Bot Inc.` | `f817e59f698f01487920c00ede2dbecad5c0fa50` | host `status-parser.ts`（porcelain v1 回退解析段） |

## 3. MIT License 下的第三方材料

以下项目的材料按 MIT 进入本仓库。许可全文见本文件第 5 节（同一文本，逐条目版权行见下表）。

| 来源项目 | 版权与署名行（其 LICENSE 原文） | 版本 | 本仓库落点（登记行摘要） |
|---|---|---|---|
| deepseek-ai/deepseek-harness（dsh） | `Copyright (c) 2026 DeepSeek` | dsh 树 `ce7073d512`；发布物 `@deepseek-ai/dsh-typert-protocol@0.2.2-alpha.2` | host `git-runner.ts` / `workspace.ts` / `diff.ts` / `message-gen.ts` 范式对照等；client `diff/patch-hunks.ts` 照抄；`packages/typert-protocol/` 整包 MIT 原样再分发（副本内自带其 LICENSE/README） |
| sst/opencode | `Copyright (c) 2025 opencode` | `b6c43a524265496086fc0fdd83180bfa47d4d22e` | 语义参考（diff 双路编排 / 命令选择），零逐行搬运（C 级登记） |
| gitkraken/vscode-gitlens（MIT 区；其专有目录不在使用范围） | `Copyright (c) 2021-2026 Axosoft, LLC dba GitKraken`；`Copyright (c) 2016-2021 Eric Amodio` | `020cfc1b7daf29da1f0c6f916a550559b7a552b2` | client 图数据层类型面/契约对照（`graph/lane-layout.ts` 类型面 + `store/git-graph-store.ts` single-writer；零代码搬运，C 级登记） |

MIT License 全文：

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

（各条目版权行见第 3 节表格与第 1 节；MIT 正文逐字一致，仅版权行随持有者不同。）

## 4. Apache License 2.0 全文

（逐字照录标准 Apache-2.0 文本；第 2 节三个条目均适用本文本，各自署名行见第 2 节表格。）

```

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

```

## 5. 仅语义/思想参考、无代码进入本仓库的来源

- Aider-AI/aider（Apache-2.0；其仓库 LICENSE.txt 为未填署名模板）：仅阅读 `repo.py` 的 auto-commit 语义，零代码移植（NOTICE.md §2 登记行）。
- pvigier 博客《Commit graph drawing algorithms》（网页教材，可自由学习）：泳道布局算法思想来源；实现为本仓库原创代码（`client/graph/lane-layout.ts` 自研声明）。

上述来源无任何代码行进入本仓库，不产生随附义务；登记于此保持来源面完整。
