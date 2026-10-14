# 第三方组件声明（THIRD-PARTY NOTICES）

> 本文件由 `node scripts/generate-third-party-notices.cjs` 生成，**请勿手工编辑**。
> 覆盖范围：`package.json` 的 `dependencies` ＋ `optionalDependencies` 的**传递闭包**
> （当前 308 个包，其中 298 个读取到许可文件）
> ＋ **非 npm 来源**的第三方表达（见 §3，清单在 `scripts/non-npm-third-party-sources.json`）。
> `devDependencies` 不随包分发，故未列入。
> 法律声明与商标信息见同目录的 `NOTICE`；本包的整体许可为 Apache-2.0（见 `LICENSE`）。

## 1. 范围与来源

| 类别 | 是否随本包分发 | 说明 |
|---|---|---|
| `haruyuki.js` / `dist/**` 内联的 npm 依赖 | 是 | 单文件打包把生产依赖内联进产物，见 `build.js` 的 `external` 白名单 |
| `src/skills/builtin/self-configuration/LICENSE` | 是 | 上游随技能附带的 MIT 文本（Copyright (c) 2026 Letta, Inc.），原样保留 |
| 非 npm 来源的第三方表达（`src/agent/prompts/source_*.md`） | 是 | 为基准对照收录的外部系统提示词，见 §3 |
| `node_modules` 中的 `devDependencies` | 否 | 仅开发期使用，不进入发布产物 |

许可证原文一律**逐字保留英文原文**，不作翻译或改写。

## 2. 打包内联的 npm 依赖

下表按各包 `package.json` 声明的许可证分组。每组的「许可原文」是组内使用最多的一份**逐字**文本；
**每个包的版权行都单独列出** —— 这正是 MIT / BSD / ISC 要求随分发保留的部分。
若某个包自带的文本与组内原文不同，会在「备注」里标出，请以该包目录内的 `LICENSE` 为准。

### (MIT OR CC0-1.0) — 1 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `type-fest` | 4.41.0 | — |  |

**(MIT OR CC0-1.0) 许可原文**（组内 1 个包使用此文本）

```text
Creative Commons Legal Code

CC0 1.0 Universal

    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM AND DOES NOT PROVIDE
    LEGAL SERVICES. DISTRIBUTION OF THIS DOCUMENT DOES NOT CREATE AN
    ATTORNEY-CLIENT RELATIONSHIP. CREATIVE COMMONS PROVIDES THIS
    INFORMATION ON AN "AS-IS" BASIS. CREATIVE COMMONS MAKES NO WARRANTIES
    REGARDING THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS
    PROVIDED HEREUNDER, AND DISCLAIMS LIABILITY FOR DAMAGES RESULTING FROM
    THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS PROVIDED
    HEREUNDER.

Statement of Purpose

The laws of most jurisdictions throughout the world automatically confer
exclusive Copyright and Related Rights (defined below) upon the creator
and subsequent owner(s) (each and all, an "owner") of an original work of
authorship and/or a database (each, a "Work").

Certain owners wish to permanently relinquish those rights to a Work for
the purpose of contributing to a commons of creative, cultural and
scientific works ("Commons") that the public can reliably and without fear
of later claims of infringement build upon, modify, incorporate in other
works, reuse and redistribute as freely as possible in any form whatsoever
and for any purposes, including without limitation commercial purposes.
These owners may contribute to the Commons to promote the ideal of a free
culture and the further production of creative, cultural and scientific
works, or to gain reputation or greater distribution for their Work in
part through the use and efforts of others.

For these and/or other purposes and motivations, and without any
expectation of additional consideration or compensation, the person
associating CC0 with a Work (the "Affirmer"), to the extent that he or she
is an owner of Copyright and Related Rights in the Work, voluntarily
elects to apply CC0 to the Work and publicly distribute the Work under its
terms, with knowledge of his or her Copyright and Related Rights in the
Work and the meaning and intended legal effect of CC0 on those rights.

1. Copyright and Related Rights. A Work made available under CC0 may be
protected by copyright and related or neighboring rights ("Copyright and
Related Rights"). Copyright and Related Rights include, but are not
limited to, the following:

  i. the right to reproduce, adapt, distribute, perform, display,
     communicate, and translate a Work;
 ii. moral rights retained by the original author(s) and/or performer(s);
iii. publicity and privacy rights pertaining to a person's image or
     likeness depicted in a Work;
 iv. rights protecting against unfair competition in regards to a Work,
     subject to the limitations in paragraph 4(a), below;
  v. rights protecting the extraction, dissemination, use and reuse of data
     in a Work;
 vi. database rights (such as those arising under Directive 96/9/EC of the
     European Parliament and of the Council of 11 March 1996 on the legal
     protection of databases, and under any national implementation
     thereof, including any amended or successor version of such
     directive); and
vii. other similar, equivalent or corresponding rights throughout the
     world based on applicable law or treaty, and any national
     implementations thereof.

2. Waiver. To the greatest extent permitted by, but not in contravention
of, applicable law, Affirmer hereby overtly, fully, permanently,
irrevocably and unconditionally waives, abandons, and surrenders all of
Affirmer's Copyright and Related Rights and associated claims and causes
of action, whether now known or unknown (including existing as well as
future claims and causes of action), in the Work (i) in all territories
worldwide, (ii) for the maximum duration provided by applicable law or
treaty (including future time extensions), (iii) in any current or future
medium and for any number of copies, and (iv) for any purpose whatsoever,
including without limitation commercial, advertising or promotional
purposes (the "Waiver"). Affirmer makes the Waiver for the benefit of each
member of the public at large and to the detriment of Affirmer's heirs and
successors, fully intending that such Waiver shall not be subject to
revocation, rescission, cancellation, termination, or any other legal or
equitable action to disrupt the quiet enjoyment of the Work by the public
as contemplated by Affirmer's express Statement of Purpose.

3. Public License Fallback. Should any part of the Waiver for any reason
be judged legally invalid or ineffective under applicable law, then the
Waiver shall be preserved to the maximum extent permitted taking into
account Affirmer's express Statement of Purpose. In addition, to the
extent the Waiver is so judged Affirmer hereby grants to each affected
person a royalty-free, non transferable, non sublicensable, non exclusive,
irrevocable and unconditional license to exercise Affirmer's Copyright and
Related Rights in the Work (i) in all territories worldwide, (ii) for the
maximum duration provided by applicable law or treaty (including future
time extensions), (iii) in any current or future medium and for any number
of copies, and (iv) for any purpose whatsoever, including without
limitation commercial, advertising or promotional purposes (the
"License"). The License shall be deemed effective as of the date CC0 was
applied by Affirmer to the Work. Should any part of the License for any
reason be judged legally invalid or ineffective under applicable law, such
partial invalidity or ineffectiveness shall not invalidate the remainder
of the License, and in such case Affirmer hereby affirms that he or she
will not (i) exercise any of his or her remaining Copyright and Related
Rights in the Work or (ii) assert any associated claims and causes of
action with respect to the Work, in either case contrary to Affirmer's
express Statement of Purpose.

4. Limitations and Disclaimers.

 a. No trademark or patent rights held by Affirmer are waived, abandoned,
    surrendered, licensed or otherwise affected by this document.
 b. Affirmer offers the Work as-is and makes no representations or
    warranties of any kind concerning the Work, express, implied,
    statutory or otherwise, including without limitation warranties of
    title, merchantability, fitness for a particular purpose, non
    infringement, or the absence of latent or other defects, accuracy, or
    the present or absence of errors, whether or not discoverable, all to
    the greatest extent permissible under applicable law.
 c. Affirmer disclaims responsibility for clearing rights of other persons
    that may apply to the Work or any use thereof, including without
    limitation any person's Copyright and Related Rights in the Work.
    Further, Affirmer disclaims responsibility for obtaining any necessary
    consents, permissions or other rights required for any use of the
    Work.
 d. Affirmer understands and acknowledges that Creative Commons is not a
    party to this document and has no duty or obligation with respect to
    this CC0 or use of the Work.
```

### 0BSD — 1 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `tslib` | 2.8.1 | Copyright (c) Microsoft Corporation. |  |

**0BSD 许可原文**（组内 1 个包使用此文本）

```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### apache-2.0 — 1 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `@pierre/diffs` | 1.2.2 | Copyright 2025 Pierre Computer Company |  |

**apache-2.0 许可原文**（组内 1 个包使用此文本）

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction, and
    distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by the
    copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all other
    entities that control, are controlled by, or are under common control with
    that entity. For the purposes of this definition, "control" means (i) the
    power, direct or indirect, to cause the direction or management of such
    entity, whether by contract or otherwise, or (ii) ownership of fifty percent
    (50%) or more of the outstanding shares, or (iii) beneficial ownership of
    such entity.

    "You" (or "Your") shall mean an individual or Legal Entity exercising
    permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation source, and
    configuration files.

    "Object" form shall mean any form resulting from mechanical transformation
    or translation of a Source form, including but not limited to compiled
    object code, generated documentation, and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or Object form,
    made available under the License, as indicated by a copyright notice that is
    included in or attached to the work (an example is provided in the Appendix
    below).

    "Derivative Works" shall mean any work, whether in Source or Object form,
    that is based on (or derived from) the Work and for which the editorial
    revisions, annotations, elaborations, or other modifications represent, as a
    whole, an original work of authorship. For the purposes of this License,
    Derivative Works shall not include works that remain separable from, or
    merely link (or bind by name) to the interfaces of, the Work and Derivative
    Works thereof.

    "Contribution" shall mean any work of authorship, including the original
    version of the Work and any modifications or additions to that Work or
    Derivative Works thereof, that is intentionally submitted to Licensor for
    inclusion in the Work by the copyright owner or by an individual or Legal
    Entity authorized to submit on behalf of the copyright owner. For the
    purposes of this definition, "submitted" means any form of electronic,
    verbal, or written communication sent to the Licensor or its
    representatives, including but not limited to communication on electronic
    mailing lists, source code control systems, and issue tracking systems that
    are managed by, or on behalf of, the Licensor for the purpose of discussing
    and improving the Work, but excluding communication that is conspicuously
    marked or otherwise designated in writing by the copyright owner as "Not a
    Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity on
    behalf of whom a Contribution has been received by Licensor and subsequently
    incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable copyright license to
    reproduce, prepare Derivative Works of, publicly display, publicly perform,
    sublicense, and distribute the Work and such Derivative Works in Source or
    Object form.

3.  Grant of Patent License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable (except as stated in
    this section) patent license to make, have made, use, offer to sell, sell,
    import, and otherwise transfer the Work, where such license applies only to
    those patent claims licensable by such Contributor that are necessarily
    infringed by their Contribution(s) alone or by combination of their
    Contribution(s) with the Work to which such Contribution(s) was submitted.
    If You institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work or a
    Contribution incorporated within the Work constitutes direct or contributory
    patent infringement, then any patent licenses granted to You under this
    License for that Work shall terminate as of the date such litigation is
    filed.

4.  Redistribution. You may reproduce and distribute copies of the Work or
    Derivative Works thereof in any medium, with or without modifications, and
    in Source or Object form, provided that You meet the following conditions:

    (a) You must give any other recipients of the Work or Derivative Works a
    copy of this License; and

    (b) You must cause any modified files to carry prominent notices stating
    that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works that You
    distribute, all copyright, patent, trademark, and attribution notices from
    the Source form of the Work, excluding those notices that do not pertain to
    any part of the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its distribution,
    then any Derivative Works that You distribute must include a readable copy
    of the attribution notices contained within such NOTICE file, excluding
    those notices that do not pertain to any part of the Derivative Works, in at
    least one of the following places: within a NOTICE text file distributed as
    part of the Derivative Works; within the Source form or documentation, if
    provided along with the Derivative Works; or, within a display generated by
    the Derivative Works, if and wherever such third-party notices normally
    appear. The contents of the NOTICE file are for informational purposes only
    and do not modify the License. You may add Your own attribution notices
    within Derivative Works that You distribute, alongside or as an addendum to
    the NOTICE text from the Work, provided that such additional attribution
    notices cannot be construed as modifying the License.

    You may add Your own copyright statement to Your modifications and may
    provide additional or different license terms and conditions for use,
    reproduction, or distribution of Your modifications, or for any such
    Derivative Works as a whole, provided Your use, reproduction, and
    distribution of the Work otherwise complies with the conditions stated in
    this License.

5.  Submission of Contributions. Unless You explicitly state otherwise, any
    Contribution intentionally submitted for inclusion in the Work by You to the
    Licensor shall be under the terms and conditions of this License, without
    any additional terms or conditions. Notwithstanding the above, nothing
    herein shall supersede or modify the terms of any separate license agreement
    you may have executed with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade names,
    trademarks, service marks, or product names of the Licensor, except as
    required for reasonable and customary use in describing the origin of the
    Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or agreed to in
    writing, Licensor provides the Work (and each Contributor provides its
    Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied, including, without limitation, any
    warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
    FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining
    the appropriateness of using or redistributing the Work and assume any risks
    associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory, whether in
    tort (including negligence), contract, or otherwise, unless required by
    applicable law (such as deliberate and grossly negligent acts) or agreed to
    in writing, shall any Contributor be liable to You for damages, including
    any direct, indirect, special, incidental, or consequential damages of any
    character arising as a result of this License or out of the use or inability
    to use the Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all other
    commercial damages or losses), even if such Contributor has been advised of
    the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing the Work or
    Derivative Works thereof, You may choose to offer, and charge a fee for,
    acceptance of support, warranty, indemnity, or other liability obligations
    and/or rights consistent with this License. However, in accepting such
    obligations, You may act only on Your own behalf and on Your sole
    responsibility, not on behalf of any other Contributor, and only if You
    agree to indemnify, defend, and hold each Contributor harmless for any
    liability incurred by, or claims asserted against, such Contributor by
    reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
```

### Apache-2.0 — 51 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `@aws-crypto/crc32` | 5.2.0 | Copyright {yyyy} {name of copyright owner} |  |
| `@aws-crypto/sha256-browser` | 5.2.0 | — | 文本有变体 |
| `@aws-crypto/sha256-js` | 5.2.0 | Copyright {yyyy} {name of copyright owner} |  |
| `@aws-crypto/supports-web-crypto` | 5.2.0 | — | 文本有变体 |
| `@aws-crypto/util` | 5.2.0 | Copyright {yyyy} {name of copyright owner} |  |
| `@aws-sdk/client-bedrock-runtime` | 3.1127.0 | Copyright 2018-2023 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/core` | 3.978.0 | Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved. | 文本有变体 |
| `@aws-sdk/credential-provider-env` | 3.972.39 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/credential-provider-http` | 3.972.41 | — | 无许可文件 |
| `@aws-sdk/credential-provider-ini` | 3.972.43 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/credential-provider-login` | 3.972.43 | — | 无许可文件 |
| `@aws-sdk/credential-provider-node` | 3.972.44 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/credential-provider-process` | 3.972.39 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/credential-provider-sso` | 3.972.43 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/credential-provider-web-identity` | 3.972.43 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/eventstream-handler-node` | 3.972.34 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/middleware-eventstream` | 3.972.29 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/middleware-websocket` | 3.972.53 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/nested-clients` | 3.997.11 | — | 无许可文件 |
| `@aws-sdk/signature-v4-multi-region` | 3.996.28 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/token-providers` | 3.1127.0 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/types` | 3.973.9 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/util-locate-window` | 3.965.5 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws-sdk/xml-builder` | 3.972.40 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@aws/lambda-invoke-store` | 0.3.0 | — | 文本有变体 |
| `@google/genai` | 2.21.0 | — | 文本有变体 |
| `@janhapke/sharp-electron` | 0.35.3-electron.1 | Jan Hapke <sharp-electron@janhapke.com> | 文本有变体 |
| `@letta-ai/letta-agent-sdk` | 0.8.24 | Copyright 2025, Letta authors | 文本有变体 |
| `@letta-ai/letta-client` | 1.10.2 | Copyright 2026 Letta | 文本有变体 |
| `@letta-ai/letta-code` | 0.33.7 | Copyright 2025, Letta authors | 文本有变体 |
| `@letta-ai/trajectory` | 0.2.0 | Copyright 2025, Letta authors | 文本有变体 |
| `@scarf/scarf` | 1.4.0 | Copyright 2020 Scarf Systems, Inc. | 文本有变体 |
| `@smithy/core` | 3.24.4 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/credential-provider-imds` | 4.3.2 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/fetch-http-handler` | 5.8.0 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/is-array-buffer` | 2.2.0 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/node-http-handler` | 4.12.1 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/signature-v4` | 5.4.2 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/types` | 4.14.2 | Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/util-buffer-from` | 2.2.0 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `@smithy/util-utf8` | 2.3.0 | Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved. |  |
| `detect-libc` | 2.1.2 | Copyright {yyyy} {name of copyright owner} |  |
| `ecdsa-sig-formatter` | 1.0.11 | Copyright 2015 D2L Corporation |  |
| `gaxios` | 7.1.4 | Google, LLC | 文本有变体 |
| `gcp-metadata` | 8.1.2 | Google LLC | 文本有变体 |
| `google-auth-library` | 10.6.2 | Google Inc. | 文本有变体 |
| `google-logging-utils` | 1.1.3 | Google API Authors | 文本有变体 |
| `long` | 5.3.2 | Daniel Wirtz <dcode@dcode.io> | 文本有变体 |
| `openai` | 6.48.0 | Copyright 2026 OpenAI | 文本有变体 |
| `sharp` | 0.34.5 | Lovell Fuller <npm@lovell.info> | 文本有变体 |
| `typescript` | 5.9.3 | Microsoft Corp. | 文本有变体 |

**Apache-2.0 许可原文**（组内 29 个包使用此文本）

```text
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

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

> 另有 6 种文本变体（共 19 个包，见上表「文本有变体」），以各包目录内的 `LICENSE` 为准。

> ⚠️ 这些包未附许可文件，仅按 `package.json` 的 `license` 字段登记：`@aws-sdk/credential-provider-http`、`@aws-sdk/credential-provider-login`、`@aws-sdk/nested-clients`

### BlueOak-1.0.0 — 2 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `glob` | 13.0.0 | ## Copyright | 文本有变体 |
| `path-scurry` | 2.0.1 | ## Copyright |  |

**BlueOak-1.0.0 许可原文**（组内 1 个包使用此文本）

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

> 另有 1 种文本变体（共 1 个包，见上表「文本有变体」），以各包目录内的 `LICENSE` 为准。

### BSD-2-Clause — 2 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `json-schema-typed` | 8.0.2 | — | 文本有变体 |
| `webidl-conversions` | 3.0.1 | Copyright (c) 2014, Domenic Denicola |  |

**BSD-2-Clause 许可原文**（组内 1 个包使用此文本）

```text
# The BSD 2-Clause License

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

> 另有 1 种文本变体（共 1 个包，见上表「文本有变体」），以各包目录内的 `LICENSE` 为准。

### BSD-3-Clause — 15 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `@protobufjs/aspromise` | 1.1.2 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/base64` | 1.1.2 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/codegen` | 2.0.5 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/eventemitter` | 1.1.0 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/fetch` | 1.1.0 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/float` | 1.0.2 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/inquire` | 1.1.1 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/path` | 1.1.2 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/pool` | 1.1.0 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `@protobufjs/utf8` | 1.1.1 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. |  |
| `buffer-equal-constant-time` | 1.0.1 | Copyright (c) 2013, GoInstant Inc., a salesforce.com company | 文本有变体 |
| `diff` | 8.0.2 | Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com> | 文本有变体 |
| `fast-uri` | 3.1.4 | Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae / Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team> | 文本有变体 |
| `protobufjs` | 7.5.8 | Copyright (c) 2016, Daniel Wirtz  All rights reserved. | 文本有变体 |
| `qs` | 6.15.1 | Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors) | 文本有变体 |

**BSD-3-Clause 许可原文**（组内 10 个包使用此文本）

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

> 另有 4 种文本变体（共 5 个包，见上表「文本有变体」），以各包目录内的 `LICENSE` 为准。

### ISC — 13 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `@ungap/structured-clone` | 1.3.1 | Copyright (c) 2021, Andrea Giammarchi, @WebReflection |  |
| `inherits` | 2.0.4 | Copyright (c) Isaac Z. Schlueter |  |
| `isexe` | 2.0.0 | Copyright (c) Isaac Z. Schlueter and Contributors |  |
| `lru-cache` | 11.2.2 | Copyright (c) 2010-2023 Isaac Z. Schlueter and Contributors |  |
| `minimatch` | 10.0.3 | Copyright (c) 2011-2023 Isaac Z. Schlueter and Contributors |  |
| `minipass` | 7.1.2 | Copyright (c) 2017-2023 npm, Inc., Isaac Z. Schlueter, and Contributors |  |
| `once` | 1.4.0 | Copyright (c) Isaac Z. Schlueter and Contributors |  |
| `semver` | 7.8.5 | Copyright (c) Isaac Z. Schlueter and Contributors |  |
| `setprototypeof` | 1.2.0 | Copyright (c) 2015, Wes Todd |  |
| `signal-exit` | 3.0.7 | Copyright (c) 2015, Contributors |  |
| `which` | 2.0.2 | Copyright (c) Isaac Z. Schlueter and Contributors |  |
| `wrappy` | 1.0.2 | Copyright (c) Isaac Z. Schlueter and Contributors |  |
| `zod-to-json-schema` | 3.25.2 | Copyright (c) 2020, Stefan Terdell |  |

**ISC 许可原文**（组内 13 个包使用此文本）

```text
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### MIT — 221 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `@alcalzone/ansi-tokenize` | 0.3.1 | Copyright (c) 2020-2026 AlCalzone |  |
| `@anthropic-ai/sdk` | 0.124.0 | Copyright 2023 Anthropic, PBC. |  |
| `@babel/runtime` | 7.29.2 | Copyright (c) 2014-present Sebastian McKenzie and other contributors |  |
| `@earendil-works/pi-ai` | 0.99.1 | Mario Zechner | 无许可文件 |
| `@earendil-works/pi-telemetry` | 0.99.1 | Mario Zechner | 无许可文件 |
| `@hono/node-server` | 2.0.12 | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors |  |
| `@img/colour` | 1.1.0 | Copyright (c) 2012 Heather Arthur / Copyright (c) 2011-2016 Heather Arthur <fayearthur@gmail.com>. / Copyright (c) 2016-2021 Josh Junon <josh@junon.me>. | 文本有变体 |
| `@isaacs/balanced-match` | 4.0.1 | — | 文本有变体 |
| `@isaacs/brace-expansion` | 5.0.0 | Copyright Julian Gruber <julian@juliangruber.com> | 文本有变体 |
| `@modelcontextprotocol/sdk` | 1.30.0 | Copyright (c) 2024 Anthropic, PBC |  |
| `@pierre/theme` | 1.0.3 | Copyright (c) 2026 The Pierre Computer Company |  |
| `@shikijs/core` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/engine-javascript` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/engine-oniguruma` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/langs` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/primitive` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/themes` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/transformers` | 3.23.0 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/types` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `@shikijs/vscode-textmate` | 10.0.2 | Copyright (c) Microsoft Corporation |  |
| `@stablelib/base64` | 1.0.1 | Copyright (C) 2016 Dmitry Chestnykh | 文本有变体 |
| `@types/hast` | 3.0.4 | Copyright (c) Microsoft Corporation. | 文本有变体 |
| `@types/mdast` | 4.0.4 | Copyright (c) Microsoft Corporation. | 文本有变体 |
| `@types/node` | 24.9.1 | Copyright (c) Microsoft Corporation. | 文本有变体 |
| `@types/retry` | 0.12.0 | Copyright (c) Microsoft Corporation. All rights reserved. | 文本有变体 |
| `@types/unist` | 3.0.3 | Copyright (c) Microsoft Corporation. | 文本有变体 |
| `@vscode/ripgrep` | 1.17.0 | Copyright (c) Microsoft Corporation | 文本有变体 |
| `accepts` | 2.0.0 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `agent-base` | 7.1.4 | Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net> | 文本有变体 |
| `ajv` | 8.20.0 | Copyright (c) 2015-2021 Evgeny Poberezkin |  |
| `ajv-formats` | 3.0.1 | Copyright (c) 2020 Evgeny Poberezkin |  |
| `ansi-escapes` | 7.3.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `ansi-regex` | 6.2.2 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `ansi-styles` | 6.2.3 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `auto-bind` | 5.0.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `base64-js` | 1.5.1 | Copyright (c) 2014 Jameson Little |  |
| `bignumber.js` | 9.3.1 | Copyright © `<2025>` `Michael Mclaughlin` | 文本有变体 |
| `body-parser` | 2.2.2 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `bowser` | 2.14.1 | Copyright 2015, Dustin Diaz (the "Original Author") | 文本有变体 |
| `buffer-crc32` | 0.2.13 | Copyright (c) 2013 Brian J. Brennan |  |
| `bundle-name` | 4.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `bytes` | 3.1.2 | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca> / Copyright (c) 2015 Jed Watson <jed.watson@me.com> | 文本有变体 |
| `call-bind-apply-helpers` | 1.0.2 | Copyright (c) 2024 Jordan Harband |  |
| `call-bound` | 1.0.4 | Copyright (c) 2024 Jordan Harband |  |
| `ccount` | 2.0.1 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `chalk` | 5.6.2 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `character-entities-html4` | 2.1.0 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `character-entities-legacy` | 3.0.0 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `cli-boxes` | 4.0.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `cli-cursor` | 4.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `cli-truncate` | 6.1.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `code-excerpt` | 4.0.0 | Copyright (c) Vadim Demedes <vdemedes@gmail.com> (github.com/vadimdemedes) |  |
| `comma-separated-tokens` | 2.0.3 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `content-disposition` | 1.1.0 | Copyright (c) 2014-2017 Douglas Christopher Wilson | 文本有变体 |
| `content-type` | 1.0.5 | Copyright (c) 2015 Douglas Christopher Wilson | 文本有变体 |
| `convert-to-spaces` | 2.0.1 | Copyright (c) Vadim Demedes <vdemedes@gmail.com> (https://vadimdemedes.com) |  |
| `cookie` | 0.7.2 | Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com> / Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `cookie-signature` | 1.2.2 | Copyright (c) 2012–2024 LearnBoost <tj@learnboost.com> and other contributors; | 文本有变体 |
| `cors` | 2.8.6 | Copyright (c) 2013 Troy Goode <troygoode@gmail.com> | 文本有变体 |
| `cron-parser` | 5.6.1 | Copyright (c) 2014-2023 Harri Siirak |  |
| `cross-spawn` | 7.0.6 | Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> |  |
| `debug` | 4.4.3 | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca> / Copyright (c) 2018-2021 Josh Junon | 文本有变体 |
| `default-browser` | 5.2.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `default-browser-id` | 5.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `define-lazy-prop` | 3.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `depd` | 2.0.0 | Copyright (c) 2014-2018 Douglas Christopher Wilson | 文本有变体 |
| `dequal` | 2.0.3 | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |  |
| `devlop` | 1.1.0 | Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `dunder-proto` | 1.0.1 | Copyright (c) 2024 ECMAScript Shims |  |
| `ee-first` | 1.1.1 | Copyright (c) 2014 Jonathan Ong me@jongleberry.com |  |
| `encodeurl` | 2.0.0 | Copyright (c) 2016 Douglas Christopher Wilson | 文本有变体 |
| `environment` | 1.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `es-define-property` | 1.0.1 | Copyright (c) 2024 Jordan Harband |  |
| `es-errors` | 1.3.0 | Copyright (c) 2024 Jordan Harband |  |
| `es-object-atoms` | 1.1.1 | Copyright (c) 2024 Jordan Harband |  |
| `es-toolkit` | 1.52.0 | Copyright (c) 2024 Viva Republica, Inc. |  |
| `escape-html` | 1.0.3 | Copyright (c) 2012-2013 TJ Holowaychuk / Copyright (c) 2015 Andreas Lubbe / Copyright (c) 2015 Tiancheng "Timothy" Gu | 文本有变体 |
| `escape-string-regexp` | 2.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `etag` | 1.8.1 | Copyright (c) 2014-2016 Douglas Christopher Wilson | 文本有变体 |
| `eventsource` | 3.0.7 | Copyright (c) EventSource GitHub organisation |  |
| `eventsource-parser` | 3.1.0 | Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com> |  |
| `express` | 5.2.1 | Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca> / Copyright (c) 2013-2014 Roman Shtylman <shtylman+expressjs@gmail.com> / Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `express-rate-limit` | 8.6.1 | Copyright 2023 Nathan Friedly, Vedant K | 文本有变体 |
| `extend` | 3.0.2 | Copyright (c) 2014 Stefan Thomas |  |
| `fast-deep-equal` | 3.1.3 | Copyright (c) 2017 Evgeny Poberezkin |  |
| `fd-slicer` | 1.1.0 | Copyright (c) 2014 Andrew Kelley |  |
| `finalhandler` | 2.1.1 | Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `forwarded` | 0.2.0 | Copyright (c) 2014-2017 Douglas Christopher Wilson | 文本有变体 |
| `fresh` | 2.0.0 | Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca> / Copyright (c) 2016-2017 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `function-bind` | 1.1.2 | Copyright (c) 2013 Raynos. |  |
| `get-east-asian-width` | 1.7.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `get-intrinsic` | 1.3.0 | Copyright (c) 2020 Jordan Harband |  |
| `get-proto` | 1.0.1 | Copyright (c) 2025 Jordan Harband |  |
| `gopd` | 1.2.0 | Copyright (c) 2022 Jordan Harband |  |
| `has-flag` | 4.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `has-symbols` | 1.1.0 | Copyright (c) 2016 Jordan Harband |  |
| `hasown` | 2.0.2 | Copyright (c) Jordan Harband and contributors |  |
| `hast-util-to-html` | 9.0.5 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `hast-util-whitespace` | 3.0.0 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `hono` | 4.12.32 | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |  |
| `html-void-elements` | 3.0.0 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `http-errors` | 2.0.1 | Copyright (c) 2014 Jonathan Ong me@jongleberry.com / Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com |  |
| `http-proxy-agent` | 9.1.0 | Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net> | 文本有变体 |
| `https-proxy-agent` | 7.0.6 | Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net> | 文本有变体 |
| `iconv-lite` | 0.7.2 | Copyright (c) 2011 Alexander Shtuchkin |  |
| `indent-string` | 5.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `ink` | 7.1.1 | Copyright (c) Vadym Demedes <vadimdemedes@hey.com> (https://github.com/vadimdemedes) / Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `ink-link` | 5.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `ip-address` | 10.3.1 | Copyright (C) 2011 by Beau Gunderson |  |
| `ipaddr.js` | 1.9.1 | Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org> |  |
| `is-docker` | 3.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `is-fullwidth-code-point` | 5.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `is-in-ci` | 2.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `is-inside-container` | 1.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `is-promise` | 4.0.0 | Copyright (c) 2014 Forbes Lindesay |  |
| `is-wsl` | 3.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `jose` | 6.2.4 | Copyright (c) 2018 Filip Skokan |  |
| `json-bigint` | 1.0.0 | Copyright (c) 2013 Andrey Sidorov |  |
| `json-schema-to-ts` | 3.1.1 | Copyright (c) 2020 Thomas Aribart |  |
| `json-schema-traverse` | 1.0.0 | Copyright (c) 2017 Evgeny Poberezkin |  |
| `jwa` | 2.0.1 | Copyright (c) 2013 Brian J. Brennan |  |
| `jws` | 4.0.1 | Copyright (c) 2013 Brian J. Brennan |  |
| `lru_map` | 0.4.1 | Rasmus Andersson <me@rsms.me> | 无许可文件 |
| `luxon` | 3.7.2 | Copyright 2019 JS Foundation and other contributors |  |
| `math-intrinsics` | 1.1.0 | Copyright (c) 2024 ECMAScript Shims |  |
| `mdast-util-to-hast` | 13.2.1 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `media-typer` | 1.1.0 | Copyright (c) 2014-2017 Douglas Christopher Wilson | 文本有变体 |
| `merge-descriptors` | 2.0.0 | Copyright (c) Jonathan Ong <me@jongleberry.com> / Copyright (c) Douglas Christopher Wilson <doug@somethingdoug.com> / Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `micromark-util-character` | 2.1.1 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `micromark-util-encode` | 2.0.1 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `micromark-util-sanitize-uri` | 2.0.1 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `micromark-util-symbol` | 2.0.1 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `micromark-util-types` | 2.0.2 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `mime-db` | 1.54.0 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `mime-types` | 3.0.2 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `mimic-fn` | 2.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `ms` | 2.1.3 | Copyright (c) 2020 Vercel, Inc. |  |
| `negotiator` | 1.0.0 | Copyright (c) 2012-2014 Federico Romero / Copyright (c) 2012-2014 Isaac Z. Schlueter / Copyright (c) 2014-2015 Douglas Christopher Wilson | 文本有变体 |
| `node-addon-api` | 7.1.1 | Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators) |  |
| `node-fetch` | 2.7.0 | Copyright (c) 2016 David Frank |  |
| `node-pty` | 1.1.0 | Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/) / Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com) / Copyright (c) 2018 - present Microsoft Corporation | 文本有变体 |
| `object-assign` | 4.1.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `object-inspect` | 1.13.4 | Copyright (c) 2013 James Halliday |  |
| `on-finished` | 2.4.1 | Copyright (c) 2013 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2014 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `onetime` | 5.1.2 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `oniguruma-parser` | 0.12.2 | Copyright (c) 2025-2026 Steven Levithan |  |
| `oniguruma-to-es` | 4.3.6 | Copyright (c) 2024-2026 Steven Levithan |  |
| `open` | 10.2.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `p-retry` | 4.6.2 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `parseurl` | 1.3.3 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2014-2017 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `partial-json` | 0.1.7 | Copyright (c) 2023 Promplate Dev Team |  |
| `patch-console` | 2.0.0 | Copyright (c) Vadim Demedes <vadimdemedes@hey.com> (https://vadimdemedes.com) |  |
| `path-key` | 3.1.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `path-to-regexp` | 8.4.2 | Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com) |  |
| `pend` | 1.2.0 | Copyright (c) 2014 Andrew Kelley |  |
| `pkce-challenge` | 5.0.1 | Copyright (c) 2019 |  |
| `property-information` | 7.1.0 | Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com> | 文本有变体 |
| `proxy-addr` | 2.0.7 | Copyright (c) 2014-2016 Douglas Christopher Wilson | 文本有变体 |
| `proxy-agent-negotiate` | 1.1.0 | Nathan Rajlich <nathan@tootallnate.net> (http://n8.io/) | 无许可文件 |
| `proxy-from-env` | 1.1.0 | Copyright (C) 2016-2018 Rob Wu <rob@robwu.nl> |  |
| `range-parser` | 1.2.1 | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca> / Copyright (c) 2015-2016 Douglas Christopher Wilson <doug@somethingdoug.com | 文本有变体 |
| `raw-body` | 3.0.2 | Copyright (c) 2013-2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |  |
| `react` | 19.2.8 | Copyright (c) Meta Platforms, Inc. and affiliates. |  |
| `react-reconciler` | 0.33.0 | Copyright (c) Meta Platforms, Inc. and affiliates. |  |
| `regex` | 6.1.0 | Copyright (c) 2025 Steven Levithan |  |
| `regex-recursion` | 6.0.2 | Copyright (c) 2025 Steven Levithan |  |
| `regex-utilities` | 2.3.0 | Copyright (c) 2024 Steven Levithan |  |
| `require-from-string` | 2.0.2 | Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop) |  |
| `restore-cursor` | 4.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `retry` | 0.13.1 | Copyright (c) 2011: | 文本有变体 |
| `router` | 2.2.0 | Copyright (c) 2013 Roman Shtylman / Copyright (c) 2014-2022 Douglas Christopher Wilson | 文本有变体 |
| `run-applescript` | 7.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `safe-buffer` | 5.1.2 | Copyright (c) Feross Aboukhadijeh |  |
| `safer-buffer` | 2.1.2 | Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com> |  |
| `scheduler` | 0.27.0 | Copyright (c) Meta Platforms, Inc. and affiliates. |  |
| `send` | 1.2.1 | Copyright (c) 2012 TJ Holowaychuk / Copyright (c) 2014-2022 Douglas Christopher Wilson | 文本有变体 |
| `serve-static` | 2.2.1 | Copyright (c) 2010 Sencha Inc. / Copyright (c) 2011 LearnBoost / Copyright (c) 2011 TJ Holowaychuk | 文本有变体 |
| `shebang-command` | 2.0.0 | Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva) |  |
| `shebang-regex` | 3.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `shiki` | 4.0.2 | Copyright (c) 2021 Pine Wu / Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |  |
| `side-channel` | 1.1.0 | Copyright (c) 2019 Jordan Harband |  |
| `side-channel-list` | 1.0.1 | Copyright (c) 2024 Jordan Harband |  |
| `side-channel-map` | 1.0.1 | Copyright (c) 2024 Jordan Harband |  |
| `side-channel-weakmap` | 1.0.2 | Copyright (c) 2019 Jordan Harband |  |
| `slice-ansi` | 9.0.1 | Copyright (c) DC <threedeecee@gmail.com> / Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `space-separated-tokens` | 2.0.2 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `stack-utils` | 2.0.6 | Copyright (c) 2016-2022 Isaac Z. Schlueter <i@izs.me>, James Talmage <james@talmage.io> (github.com/jamestalmage), and Contributors |  |
| `standardwebhooks` | 1.1.1 | Standard Webhooks | 无许可文件 |
| `statuses` | 2.0.2 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |  |
| `string-width` | 8.3.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `stringify-entities` | 4.0.4 | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> | 文本有变体 |
| `strip-ansi` | 7.2.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `supports-color` | 7.2.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |  |
| `supports-hyperlinks` | 4.6.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) / Copyright (c) James Talmage <james@talmage.io> (https://github.com/jamestalmage) |  |
| `terminal-link` | 5.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `terminal-size` | 4.0.1 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `toidentifier` | 1.0.1 | Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |  |
| `tr46` | 0.0.3 | Sebastian Mayr <npm@smayr.name> | 无许可文件 |
| `trim-lines` | 3.0.1 | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> | 文本有变体 |
| `ts-algebra` | 2.0.0 | Copyright (c) 2020 Thomas Aribart |  |
| `type-is` | 2.0.1 | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> / Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `typebox` | 1.3.27 | Copyright (c) 2017-2026 Haydn Paterson | 文本有变体 |
| `undici-types` | 7.16.0 | Copyright (c) Matteo Collina and Undici contributors |  |
| `unist-util-is` | 6.0.1 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `unist-util-position` | 5.0.0 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `unist-util-stringify-position` | 4.0.0 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `unist-util-visit` | 5.1.0 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `unist-util-visit-parents` | 6.0.2 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `unpipe` | 1.0.0 | Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> | 文本有变体 |
| `vary` | 1.1.2 | Copyright (c) 2014-2017 Douglas Christopher Wilson | 文本有变体 |
| `vfile` | 6.0.3 | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `vfile-message` | 4.0.3 | Copyright (c) Titus Wormer <tituswormer@gmail.com> | 文本有变体 |
| `whatwg-url` | 5.0.0 | Copyright (c) 2015–2016 Sebastian Mayr |  |
| `widest-line` | 6.0.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `wrap-ansi` | 10.0.2 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `ws` | 8.19.0 | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com> / Copyright (c) 2013 Arnout Kazemier and contributors / Copyright (c) 2016 Luigi Pinca and contributors |  |
| `wsl-utils` | 0.1.0 | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |  |
| `yauzl` | 2.10.0 | Copyright (c) 2014 Josh Wolfe |  |
| `yoga-layout` | 3.2.1 | Meta Open Source | 无许可文件 |
| `zod` | 4.4.3 | Copyright (c) 2025 Colin McDonnell |  |
| `zwitch` | 2.0.4 | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> | 文本有变体 |

**MIT 许可原文**（组内 138 个包使用此文本）

```text
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

> 另有 14 种文本变体（共 76 个包，见上表「文本有变体」），以各包目录内的 `LICENSE` 为准。

> ⚠️ 这些包未附许可文件，仅按 `package.json` 的 `license` 字段登记：`@earendil-works/pi-ai`、`@earendil-works/pi-telemetry`、`lru_map`、`proxy-agent-negotiate`、`standardwebhooks`、`tr46`、`yoga-layout`

### Unlicense — 1 个包

| 包 | 版本 | 版权行 | 备注 |
|---|---|---|---|
| `fast-sha256` | 1.3.0 | Dmitry Chestnykh |  |

**Unlicense 许可原文**（组内 1 个包使用此文本）

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

## 3. 非 npm 来源的第三方内容

以下表达**随本包分发**，但不在 npm 依赖闭包内，
因此上面的依赖遍历**结构上扫不到**它们。清单维护在
`scripts/non-npm-third-party-sources.json`（许可原文逐字保留）。

这些提示词是**为基准对照（benchmarking）而收录的第三方原件**：本项目不是
Anthropic / OpenAI / Google 的产品，也不代表它们，文件内容不构成本项目的声明。

### src/agent/prompts/source_claude.md — MIT

- **来源**：Anthropic Claude Code system prompt, as assembled by the Piebald mirror
- **版本**：Claude Code ~v2.1.50 (Feb 2026); assembled from ~110 modular prompt files
- **上游**：https://github.com/Piebald-AI/claude-code-system-prompts
- **版权行**：Copyright (c) 2025 Piebald LLC
- **本分支是否改动**：否，与上游逐字相同
- **随包文件**：`src/agent/prompts/source_claude.md`（14250 字节，SHA-256 `5408b1828d294845f903de836fd279ba116fb376b2674369d1788216e46d7b64`）

许可原文：

```text
MIT License

Copyright (c) 2025 Piebald LLC

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

### src/agent/prompts/source_codex.md — Apache-2.0

- **来源**：OpenAI Codex CLI system prompt (models-manager instructions template)
- **版本**：extracted from openai/codex main (May 2026), rendered with personality_pragmatic
- **上游**：https://github.com/openai/codex
- **版权行**：Copyright 2025 OpenAI
- **本分支是否改动**：否，与上游逐字相同
- **随包文件**：`src/agent/prompts/source_codex.md`（21347 字节，SHA-256 `c2a980bc28af132eb89e0b4c68ae884043faae83a1afd3fd4889f7e8a1ada7b0`）

许可原文：与仓库根的 `LICENSE` **逐字相同**的标准 Apache License 2.0 文本
（openai/codex ships the standard Apache License 2.0 text, identical to the LICENSE file in this repository）
，此处不再重复贴出。

### src/agent/prompts/source_gemini.md — Apache-2.0

- **来源**：Google Gemini CLI system prompt (snippets.ts, rendered)
- **版本**：snippets.ts (Feb 2026), copyright 2026 Google LLC
- **上游**：https://github.com/google-gemini/gemini-cli
- **版权行**：Copyright 2026 Google LLC (as stated in the upstream snippets.ts header)
- **本分支是否改动**：否，与上游逐字相同
- **随包文件**：`src/agent/prompts/source_gemini.md`（18640 字节，SHA-256 `3e91857d4b9c4188ec44a18a06499d7fa34bd35791a884f5e7c6081b6bd18b03`）

许可原文：与仓库根的 `LICENSE` **逐字相同**的标准 Apache License 2.0 文本
（google-gemini/gemini-cli ships the standard Apache License 2.0 text, identical to the LICENSE file in this repository）
，此处不再重复贴出。

## 4. 依赖闭包中的上游包

以下包由 Letta, Inc. 作为**独立 npm 包**发布，本项目的依赖闭包会安装它们（未内联进 `haruyuki.js`）：

- `@letta-ai/letta-agent-sdk@0.8.24` — Apache-2.0
- `@letta-ai/letta-client@1.10.2` — Apache-2.0
- `@letta-ai/letta-code@0.33.7` — Apache-2.0
- `@letta-ai/trajectory@0.2.0` — Apache-2.0

它们的资产（包括上游自己的品牌图片与截图）由各自的发布者分发，**不属于本项目的分发物**；
本项目不复制、不重新打包这些资产，`npm pack` 的清单里也不含它们。

## 5. NOTICE 文件扫描（Apache-2.0 §4(d)）

Apache-2.0 要求：若被分发的第三方包里带有 `NOTICE` 文件，其内容也必须随本包传递。本闭包中命中：

### es-toolkit@1.52.0

```text
es-toolkit

Parts of the test suite and compatibility layer in es-toolkit/compat are
derived from Lodash (https://github.com/lodash/lodash).

Lodash copyright notice and MIT permission notice:

Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 7. 已知缺口

无。闭包内所有包都已解析到 `node_modules` 中的实体。

部分包只在自己的 `package.json` 里声明 `license`、不附带许可文件。上表已按声明登记；
如需更完整的信息，请查阅对应包的发布页。若你发现遗漏或错误，请以该包自身附带的许可文本为准。
