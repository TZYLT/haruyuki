# hryk

**`hryk` is the equivalent short name of [`haruyuki`](https://www.npmjs.com/package/haruyuki).**
This package ships **no code of its own**: it is a thin forwarding manifest that depends on the
main package, so installing it is the same as installing `haruyuki` itself. Both command names
run the exact same program.

`hryk` 是 [`haruyuki`](https://www.npmjs.com/package/haruyuki) 的**等价短名包**。本包
**不含任何自己的代码**——它只是一份转发清单，依赖主体包，因此装它就等于装了 `haruyuki` 本身；
两个命令名运行的是同一个程序。

## Install · 安装

```bash
npm install -g hryk      # short name · 短名
npm install -g haruyuki  # long name · 长名
```

Either one gives you **both** commands: `hryk` and `haruyuki`.
装任意一个，都会同时得到 **两个**命令：`hryk` 与 `haruyuki`。

## Use · 使用

Whichever name you type, the behaviour is identical — the long name simply appears in
user-facing text.

敲哪个名字行为都一样——用户可见文案里出现的始终是长名。

```bash
hryk --version           # {{VERSION}} (Haruyuki)
haruyuki --version       # {{VERSION}} (Haruyuki)  · identical bytes · 逐字节相同

hryk --new               # create a new conversation · 新建会话
haruyuki --agent <id>    # open a specific agent · 打开指定 agent
```

- Version `{{VERSION}}` is locked to `{{MAIN}}@{{VERSION}}`, so the short name can never pull a
  different build of the main package.
  版本 `{{VERSION}}` 与 `{{MAIN}}@{{VERSION}}` **精确锁定**，短名不可能拉到不匹配的主体包。
- Documentation, configuration and data: see the main package's README.
  文档、配置与数据：见主体包 README。

## Update · 升级

```bash
npm install -g hryk@latest
```

## License

Apache-2.0 — same as the main package.
