/**
 * 批改核心（服务端与浏览器共用）
 * - 浏览器：<script src="grade-core.js"></script> → window.GradeCore
 * - Node：require('./public/grade-core.js')
 * 这样静态托管（GitHub Pages 等）和自建服务端跑的是同一套提示词与解析逻辑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GradeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_MODEL = 'agnes-2.5-flash';
  var DEFAULT_BASE = 'https://apihub.agnes-ai.com/v1';

  /** 从模型输出中尽力抽取 JSON 对象 */
  function extractJSON(text) {
    if (!text) return null;
    var s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = s.indexOf('{');
    if (start === -1) return null;
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < s.length; i++) {
      var ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          var candidate = s.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (e) {
            try {
              return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
            } catch (e2) {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 0;
    if (typeof v === 'string') {
      var s = v.trim().toLowerCase();
      if (['true', '对', '正确', '是', 'yes', 'y', '1'].indexOf(s) >= 0) return true;
      if (['false', '错', '错误', '否', 'no', 'n', '0'].indexOf(s) >= 0) return false;
    }
    return null;
  }

  /** 规范化模型返回，保证界面拿到的结构稳定 */
  function normalize(raw, ctx) {
    ctx = ctx || {};
    var fullScore = Number(ctx.fullScore) || 100;
    var out = {
      title: (raw && (raw.title || raw.name)) || '作业',
      subject: (raw && raw.subject) || ctx.subject || '',
      score: null,
      fullScore: fullScore,
      questions: [],
      summary: (raw && (raw.summary || raw.comment || raw.overall)) || '',
      strengths: [],
      weaknesses: [],
      suggestions: [],
      teacherNote: '',
    };

    var arr = function (v) {
      if (Array.isArray(v)) return v.filter(function (x) { return x != null && x !== ''; });
      return v ? [v] : [];
    };
    out.strengths = arr(raw && (raw.strengths || raw.优点)).map(String).slice(0, 6);
    out.weaknesses = arr(raw && (raw.weaknesses || raw.不足 || raw.weakness)).map(String).slice(0, 6);
    out.suggestions = arr(raw && (raw.suggestions || raw.建议 || raw.advice)).map(String).slice(0, 6);

    var qs = (raw && (raw.questions || raw.items || raw.题目)) || [];
    if (!Array.isArray(qs)) qs = [];
    out.questions = qs.slice(0, 80).map(function (q, i) {
      if (typeof q !== 'object' || q === null) {
        return { no: String(i + 1), studentAnswer: String(q == null ? '' : q), correctAnswer: '', isCorrect: null, knowledgePoint: '', comment: '' };
      }
      var pick = function () {
        for (var k = 0; k < arguments.length; k++) {
          if (arguments[k] !== undefined && arguments[k] !== null) return arguments[k];
        }
        return '';
      };
      return {
        no: String(pick(q.no, q.number, q.index, i + 1)),
        type: String(q.type || q['题型'] || ''),
        studentAnswer: String(pick(q.studentAnswer, q.student_answer, q.answer, q['学生答案'])).trim(),
        correctAnswer: String(pick(q.correctAnswer, q.correct_answer, q.correct, q['正确答案'])).trim(),
        isCorrect: toBool(pick(q.isCorrect, q.correct, q['正确'])),
        knowledgePoint: String(pick(q.knowledgePoint, q.knowledge, q.point, q['知识点'])).trim(),
        comment: String(pick(q.comment, q['点评'], q.note)).trim(),
      };
    });

    var total = out.questions.length;
    var right = 0, wrong = 0;
    out.questions.forEach(function (q) {
      if (q.isCorrect === true) right++;
      else if (q.isCorrect === false) wrong++;
    });
    out.totalQuestions = total;
    out.correctCount = right;
    out.wrongCount = wrong;
    out.accuracy = total ? Math.round((right / total) * 1000) / 10 : 0;

    var s = Number(raw && (raw.score != null ? raw.score : raw['得分'] != null ? raw['得分'] : raw.totalScore));
    if (isFinite(s) && s >= 0) {
      out.score = Math.round(Math.min(s, fullScore) * 10) / 10;
    } else {
      out.score = total ? Math.round((right / total) * fullScore * 10) / 10 : 0;
    }
    // 分数与正确率严重不符时以正确率为准（容忍 20% 满分的主观浮动）
    if (total) {
      var expected = (right / total) * fullScore;
      if (Math.abs(out.score - expected) > fullScore * 0.2) {
        out.score = Math.round(expected * 10) / 10;
      }
    }
    return out;
  }

  /** 组装批改提示词 */
  function buildMessages(opt) {
    opt = opt || {};
    var subject = opt.subject || '';
    var fullScore = Number(opt.fullScore) || 100;
    var sys = [
      '你是一位经验丰富的' + (subject || '学科') + '老师，正在批改学生提交的作业照片。',
      '要求：',
      '1. 仔细识别图片中的每一道题：题号、学生作答内容（含手写笔迹）。',
      '2. 逐题判断对错，给出正确答案、对应知识点与简短点评。',
      '3. 若某题字迹无法辨认，isCorrect 填 null，并在 comment 中说明。',
      '4. 只输出一个 JSON 对象，不要使用 markdown 代码块，不要输出任何解释性文字。',
      '5. 所有文字使用简体中文。',
      '6. 若题目带图形（几何图、函数图像、统计图、电路图等），必须先读懂图中的标注——顶点字母、边长、角度、直角符号、平行/垂直标记、虚线与辅助线——再据此判断，不要凭空假设图形条件。',
      '7. 几何证明题不能只看结论：要检查每一步的依据是否成立、条件是否给足、有没有循环论证（把待证结论当成已知用），判定错误时在 comment 中指出具体哪一步不成立。',
      '8. 计算题若学生只写答案，按答案对错判定；若写了过程且过程有错但答案巧合正确，判为错误并说明原因。',
    ].join('\n');

    var user = [
      '请批改这份' + subject + '作业' + (opt.studentName ? '（学生：' + opt.studentName + '）' : '') + '，满分 ' + fullScore + ' 分。',
      opt.extraPrompt ? '老师补充要求：' + opt.extraPrompt : '',
      '输出 JSON，结构如下：',
      '{',
      '  "title": "作业标题（如「分数乘法练习」，无法判断则填 作业）",',
      '  "score": 得分数字（0-' + fullScore + '，与答对比例基本一致）,',
      '  "summary": "两三句总评，说明整体表现与最突出的问题",',
      '  "questions": [',
      '    {"no":"1","studentAnswer":"学生写的答案","correctAnswer":"正确答案","isCorrect":true,"knowledgePoint":"知识点","comment":"简短点评，答对可留空"}',
      '  ],',
      '  "strengths": ["做得好的地方"],',
      '  "weaknesses": ["薄弱环节"],',
      '  "suggestions": ["给学生的具体改进建议"]',
      '}',
      '注意：questions 必须逐题列出图片中全部题目（常见 3~20 道），按题号排序；漏题视为严重错误，也不要虚构不存在的题。',
    ].filter(Boolean).join('\n');

    return [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: '__IMAGE__' } },
        ],
      },
    ];
  }

  function normalizeBase(b) {
    var s = String(b || '').trim();
    if (!s) return DEFAULT_BASE;
    try {
      var u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_BASE;
      return s.replace(/\/+$/, '');
    } catch (e) {
      return DEFAULT_BASE;
    }
  }

  /** 调一次 chat/completions */
  function callChat(opt) {
    var base = normalizeBase(opt.base);
    var body = {
      model: opt.model || DEFAULT_MODEL,
      messages: (opt.messages || []).map(function (m) {
        if (!Array.isArray(m.content)) return m;
        return {
          role: m.role,
          content: m.content.map(function (p) {
            return p.type === 'image_url' ? { type: 'image_url', image_url: { url: opt.imageUrl } } : p;
          }),
        };
      }),
      temperature: 0.1,
      max_tokens: opt.maxTokens || 4096,
    };

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, opt.timeoutMs || 150000);

    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opt.key },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) {
        return r.text().then(function (text) {
          if (!r.ok) {
            var msg = text.slice(0, 400);
            try {
              msg = JSON.parse(text).error.message || msg;
            } catch (e) {}
            var err = new Error('AI 接口错误 (' + r.status + ')：' + msg);
            err.status = r.status;
            throw err;
          }
          var data = JSON.parse(text);
          return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        });
      })
      .catch(function (e) {
        if (e && e.status) throw e;
        if (e && e.name === 'AbortError') throw new Error('AI 接口响应超时，请稍后重试');
        if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo|Failed to fetch|NetworkError|network/i.test((e && e.message) || '')) {
          throw new Error('无法连接 AI 接口：请检查「设置」里的接口地址、跨域限制和网络');
        }
        throw e;
      })
      .then(function (v) {
        clearTimeout(timer);
        return v;
      }, function (e) {
        clearTimeout(timer);
        throw e;
      });
  }

  /** 完整批改流程：调用 → 解析 → 规范化（JSON 失败时重试一次） */
  function grade(opt) {
    var ctx = { subject: opt.subject || '', fullScore: Number(opt.fullScore) || 100 };
    var messages = buildMessages(opt);
    return callChat({ base: opt.base, key: opt.key, model: opt.model, messages: messages, imageUrl: opt.image, timeoutMs: opt.timeoutMs })
      .then(function (content) {
        var parsed = extractJSON(content);
        if (parsed) return parsed;
        return callChat({
          base: opt.base,
          key: opt.key,
          model: opt.model,
          imageUrl: opt.image,
          messages: messages.concat([
            { role: 'assistant', content: String(content).slice(0, 2000) },
            { role: 'user', content: '上面的输出不是合法 JSON。请只重新输出修正后的 JSON 对象，不要任何多余文字。' },
          ]),
          timeoutMs: opt.timeoutMs,
        }).then(function (c2) {
          var p2 = extractJSON(c2);
          if (!p2) throw new Error('AI 返回内容无法解析为结构化结果，请重试');
          return p2;
        });
      })
      .then(function (raw) {
        var data = normalize(raw, ctx);
        if (!data.questions.length) throw new Error('未能从图片中识别出题目，请换一张更清晰的照片');
        return data;
      });
  }

  return {
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_BASE: DEFAULT_BASE,
    extractJSON: extractJSON,
    toBool: toBool,
    normalize: normalize,
    buildMessages: buildMessages,
    normalizeBase: normalizeBase,
    callChat: callChat,
    grade: grade,
  };
});
