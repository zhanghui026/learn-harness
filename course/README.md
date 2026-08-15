# 课程正文《从三十行到 Harness》

十三课（L0–L12）的完整讲义，中英双语同页可切，单个 HTML 文件，不依赖任何外部资源。

## 怎么看

```sh
open agent-harness-course.html          # macOS
xdg-open agent-harness-course.html      # Linux
```

GitHub 不渲染仓库里的 HTML，所以直接点开链接看到的是源码。克隆下来用浏览器打开即可；页面右下角的「☰ 目录」可以跳到任意一节，末尾有 90 条术语索引。

## 怎么改

`agent-harness-course.src.html` 是**唯一的源**，插画在里面写成占位符 `<img class="ill" data-src="<slug>">`。

```sh
python3 build.py    # 把 img/ 里的图内联成 data URI，生成 agent-harness-course.html
```

三件事由 `build.py` 自动生成，**不要手写**：每课开头的小目录、右下角悬浮的全局大纲、以及所有锚点的连通性。改完正文重新构建即可，目录会自己长出来。

十张比喻插画由 MiniMax 的 `mmx image generate` 生成，原图缩到 820px、quality 72 存在 `img/`。之所以要内联而不是引用文件，是因为这份讲义最初发布为一个禁止外部请求的单页制品——顺带的好处是：这一个 HTML 文件可以随便拷到哪里，离线也能看。

## 和代码的关系

上一级目录的 `l1`–`l11` 是这门课每一课的可运行代码，讲义里的每一段 transcript 都是那些文件真跑出来的输出，不是示意。想验证任何一段，去跑对应的那个文件。
