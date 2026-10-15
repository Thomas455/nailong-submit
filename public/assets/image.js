/* ============================================================================
   图片处理：在浏览器里完成「转 webp + 压缩 + 抹 EXIF」

   为什么放在前端做（而不是 Worker 里）：
     1. Worker 里做图片处理要拉 Wasm 图片库，吃 CPU 时间额度，还容易踩坑；
        浏览器的 Canvas 是现成的、免费的、而且快。
     2. **原始文件根本不上传** —— 只传处理后的 webp。省流量，也少一次隐私暴露。

   ⚠️ 抹 EXIF 是必须做的，不是优化：
      手机拍的照片带 GPS 坐标。有人在家拍张画传上来，不处理就等于把自家位置公开。
      Canvas 重绘天然丢弃所有元数据（EXIF/GPS/设备型号），所以走这条路就自动安全了。

   顺带解决「方向」问题：
      手机竖拍的照片实际像素是横的，靠 EXIF 的 orientation 标记来转正。
      EXIF 被抹掉之后，如果像素没转正，图就横过来了。
      现代浏览器的 <img> 渲染和 drawImage 都会自动应用 orientation，
      所以画进 canvas 时已经是转正的样子，抹掉 EXIF 也不受影响。
      （Chrome 81+ / Safari 13.4+ / Firefox 77+ 都是这个行为）
   ============================================================================ */
(function (global) {
  'use strict';

  var CFG = global.SUBMIT_CONFIG.image;

  // 浏览器能不能编码 webp。绝大多数现代浏览器都行；万一不行就退回 jpeg，
  // 免得提交上去的文件主站认不出来（主站只读 .webp）。
  var webpOK = null;
  function canEncodeWebp() {
    if (webpOK !== null) return webpOK;
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      webpOK = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) {
      webpOK = false;
    }
    return webpOK;
  }

  // ---- 读文件成 Image ----
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这个文件读不出来，可能不是图片，或者是浏览器不支持的格式（比如 iPhone 的 HEIC）'));
      };
      img.src = url;
    });
  }

  // ---- 等比缩放到最长边以内 ----
  function fitCanvas(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.min(1, CFG.maxEdge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));

    var c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    var ctx = c.getContext('2d');

    // 缩小时开高质量插值，否则细节会糊
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 透明背景填白：webp 支持透明，但主站列表里的图都是不透明的，
    // 这里也统一成白底，免得 PNG 的透明区域在深色页面上变成黑块
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);

    ctx.drawImage(img, 0, 0, cw, ch);
    return c;
  }

  // ---- canvas → Blob ----
  function toBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error('图片编码失败'));
      }, mime, quality);
    });
  }

  // ---- 压到体积上限以内（逐步降质量）----
  function compress(canvas) {
    var mime = canEncodeWebp() ? 'image/webp' : 'image/jpeg';

    function attempt(q) {
      return toBlob(canvas, mime, q).then(function (blob) {
        // 够小，或者质量已经降到下限，就用它
        if (blob.size <= CFG.maxBytes || q <= CFG.minQuality) {
          return { blob: blob, quality: q, mime: mime };
        }
        return attempt(Math.max(CFG.minQuality, q - 0.1));
      });
    }

    return attempt(CFG.quality);
  }

  /**
   * 处理一个文件：读 → 缩放 → 编码 → 压缩
   * @param {File} file
   * @param {string} outName 输出文件名（不含扩展名）
   * @returns {Promise<{name:string, blob:Blob, width:number, height:number,
   *                    originalSize:number, quality:number, mime:string}>}
   */
  function process(file, outName) {
    return loadImage(file).then(function (img) {
      var canvas = fitCanvas(img);
      return compress(canvas).then(function (r) {
        var ext = r.mime === 'image/webp' ? '.webp' : '.jpg';
        return {
          name: outName + ext,
          blob: r.blob,
          width: canvas.width,
          height: canvas.height,
          originalSize: file.size,
          quality: r.quality,
          mime: r.mime
        };
      });
    });
  }

  // ---- 文件名消毒 ----
  // 仓库里的作品名会被写进 list.txt，而 list.txt 是「一行一个文件名」，
  // 所以换行、斜杠这些会破坏格式的字符必须去掉。
  function sanitizeName(raw) {
    return String(raw || '')
      .replace(/[\r\n\t]/g, ' ')          // 换行会把 list.txt 一行拆成两行
      .replace(/[/\\]/g, '·')             // 斜杠不能做文件名
      .replace(/[:*?"<>|]/g, '')          // Windows 保留字符
      .replace(/^\.+/, '')                // 别弄出隐藏文件
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);                      // 太长的话路径会很难看
  }

  global.SubmitImage = {
    canEncodeWebp: canEncodeWebp,
    process: process,
    sanitizeName: sanitizeName
  };
})(window);
