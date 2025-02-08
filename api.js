const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

/**
 * 获取短链接的 307 地址
 */
async function getRedirectLocation(url) {
    try {
        const response = await axios.get(url, {
            maxRedirects: 0,
            validateStatus: (status) => status === 307,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
            },
        });
        return response.headers?.location;
    } catch (error) {
        console.error("获取重定向地址失败:", error.message);
        return null;
    }
}

/**
 * JSON 处理函数，将 JavaScript 对象转换为 JSON 对象
 */
function cleanJsToJson(jsStr) {
    return jsStr
        .replace(/\bundefined\b/g, 'null') // 替换 undefined 为 null
        .replace(/,\s*([}\]])/g, '$1');   // 清除多余的逗号
}

/**
 * 提取 `window.__INITIAL_STATE__`
 */
function extractInitialState(html) {
    const scriptPattern = /<script[^>]*>(.*?)<\/script>/gis;
    const jsonPattern = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})(?=;|$)/;

    let match;
    while ((match = scriptPattern.exec(html)) !== null) {
        if (match[1].includes('window.__INITIAL_STATE__')) {
            const jsonMatch = jsonPattern.exec(match[1]);
            if (jsonMatch) {
                return jsonMatch[1];
            }
        }
    }
    return null;
}

/**
 * 抓取页面并提取 `window.__INITIAL_STATE__`
 */
async function fetchInitialState(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
            },
        });

        const rawJsonStr = extractInitialState(response.data);
        if (!rawJsonStr) return null;

        const cleanedJsonStr = cleanJsToJson(rawJsonStr);
        return JSON.parse(cleanedJsonStr);
    } catch (error) {
        console.error("抓取页面数据失败:", error.message);
        return null;
    }
}

/**
 * 从 `imageList` 中提取 `urlDefault` 且 `livePhoto` 为 False 的图片 URL
 */
function filterImages(noteData) {
    console.log('noteDta =>',JSON.stringify(noteData))
    return (noteData.imageList || [])
        // 这里注释掉则可以拿到live图的封面图
        // .filter((image) => !image?.livePhoto && image.urlDefault)
        .map((image) => image.urlDefault);
}

/**
 * 提取笔记数据
 */
function extractNoteData(initialState, requiredType) {
    const noteSection = initialState.note || {};
    const noteDetailMap = noteSection.noteDetailMap || {};

    for (const noteId in noteDetailMap) {
        const noteData = noteDetailMap[noteId]?.note || {};
        if (noteData.type !== requiredType) return null;

        return {
            imageList: filterImages(noteData),
            xsecToken: noteData.xsecToken || "",
            noteId: noteData.noteId || "",
            time: noteData.time || 0,
            title: noteData.title || "",
            type: noteData.type || "",
            desc: noteData.desc || "",
            tagList: noteData.tagList || [],
        };
    }
    return null;
}

/**
 * 主路由：接收 POST 请求并返回对应的笔记数据
 */
app.post('/getNote', async (req, res) => {
    const { url, type = "normal" } = req.body;

    if (!url) {
        return res.json({
            code: -1,
            success: false,
            msg: "缺少参数 `url`",
            data: null,
        });
    }

    let redirectUrl = url;

    // console.log(`请求链接: ${url}`)

    // 处理短链接
    if (url.includes("xhslink.com")) {
        redirectUrl = await getRedirectLocation(url);
        if (!redirectUrl) {
            return res.json({
                code: -1,
                success: false,
                msg: "无法获取重定向地址",
                data: null,
            });
        }
    }

    // 检查链接是否包含 xsec_token
    if (!redirectUrl.includes("xsec_token")) {
        return res.json({
            code: -1,
            success: false,
            msg: "链接缺少 `xsec_token`",
            data: null,
        });
    }

    // 提取 note_id 和 xsec_token
    const match = /\/(?:item|explore)\/(\w+).*?xsec_token=([\w-]+)/.exec(redirectUrl);
    if (!match) {
        return res.json({
            code: -1,
            success: false,
            msg: "链接不包含有效的 `note_id` 或 `xsec_token`",
            data: null,
        });
    }

    const [_, noteId, xsecToken] = match;
    const formattedUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${xsecToken}&xsec_source=pc_feed`;

    const initialState = await fetchInitialState(formattedUrl);
    if (!initialState) {
        return res.json({
            code: -1,
            success: false,
            msg: "无法提取页面数据",
            data: null,
        });
    }

    const noteData = extractNoteData(initialState, type);
    if (!noteData) {
        return res.json({
            code: -1,
            success: false,
            msg: "未找到指定类型的笔记",
            data: null,
        });
    }

    console.log(`成功获取笔记数据: ${JSON.stringify(noteData)}`)

    // TODO 拿到的数据是 {imageList:[...],...} ==> http://sns-webpic-qc.xhscdn.com/202501040310/31209bcb3908a9bd4267465c616617ea/1040g2sg319mn1kd3ncd05ouj88p9t4v0lbkukpo!nd_dft_wlteh_jpg_3"
    // TODO 需要删掉{http:}然后提取{1040g2sg319mn1kd3ncd05ouj88p9t4v0lbkukpo}组成{//sns-na-i3.xhscdn.com/1040g2sg319mn1kd3ncd05ouj88p9t4v0lbkukpo}
    noteData.imageList = noteData.imageList.map((url) => {
        // 第一种情况：匹配 "notes_pre_post" 或 "spectrum"
        let match = url.match(/https?:\/\/sns-webpic-qc\.xhscdn\.com\/.*\/(notes_pre_post|spectrum)\/([^\/!]+)!/);
        if (match) {
            const prefix = match[1]; // "notes_pre_post" 或 "spectrum"
            const imageId = match[2]; // 提取图片 ID
            return `//sns-na-i3.xhscdn.com/${prefix}/${imageId}`; // 构造相对协议的 URL
        }
        // 第二种情况：匹配特定格式 URL
        match = url.match(/https?:\/\/sns-webpic-qc\.xhscdn\.com\/\d+\/[^\/]+\/([^\/!]+)!/);
        if (match) {
            const imageId = match[1]; // 提取图片 ID
            return `//sns-na-i3.xhscdn.com/${imageId}`; // 构造相对协议的 URL
        }
        return url; // 如果不匹配，保持原样
    });

    return res.json({
        code: 0,
        success: true,
        msg: "成功",
        data: noteData,
    });
});

app.listen(8008, () => {
    console.log("服务已启动，监听端口 8008");
});