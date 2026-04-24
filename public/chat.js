// ─── 마크다운 렌더링 설정 ─────────────────────────────────────────────────────
marked.setOptions({ breaks: true }); // 줄바꿈(\n)을 <br>로 변환

// AI 응답 텍스트를 마크다운 → HTML로 변환 후 XSS 위험 태그 제거
function renderMarkdown(text) {
    try {
        const result = marked.parse(text);
        // marked가 문자열이 아닌 값을 반환할 경우 줄바꿈 처리된 plain text로 대체
        const html = typeof result === 'string' ? result : '';
        return DOMPurify.sanitize(html || text.replace(/\n/g, '<br>'));
    } catch (e) {
        // 파싱 자체가 실패하면 HTML 특수문자를 이스케이프해서 안전하게 출력
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    }
}

// ─── 상태 변수 ────────────────────────────────────────────────────────────────
let ragMode = false; // 현재 모드: false = 일반 채팅, true = RAG 채팅

// 모드별로 대화 내역을 분리 저장 (모드 전환 시 각자의 이력 유지)
const history = { normal: [], rag: [] };

// 현재 모드에 맞는 대화 내역 배열 반환
function currentHistory() {
    return ragMode ? history.rag : history.normal;
}

// ─── 메시지 렌더링 ────────────────────────────────────────────────────────────
// 말풍선 하나를 생성해 채팅 박스에 추가하고 대화 내역에 기록
function addMessage(text, role) {
    const msg = $('<div>').addClass('message ' + role);
    if (role === 'ai') {
        msg.html(renderMarkdown(text)); // AI 응답은 마크다운 렌더링
    } else {
        msg.text(text); // 사용자 메시지는 plain text (XSS 방지)
    }
    $('#chat-box').append(msg);
    currentHistory().push({ text, role });
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight; // 최신 메시지로 스크롤
}

// 모드 전환 시 해당 모드의 전체 대화 내역을 채팅 박스에 다시 그림
function renderHistory(messages) {
    $('#chat-box').empty();
    messages.forEach(function(m) {
        const msg = $('<div>').addClass('message ' + m.role);
        if (m.role === 'ai') {
            msg.html(renderMarkdown(m.text));
        } else {
            msg.text(m.text);
        }
        $('#chat-box').append(msg);
    });
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

// ─── 타이핑 인디케이터 ────────────────────────────────────────────────────────
// AI가 응답을 생성하는 동안 점 3개가 튀어오르는 애니메이션 말풍선 표시
function showTyping() {
    const bubble = $('<div class="message ai typing-bubble">');
    bubble.html('<div class="typing-indicator"><span></span><span></span><span></span></div>');
    $('#chat-box').append(bubble);
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

// 타이핑 인디케이터 말풍선 제거
function hideTyping() {
    $('.typing-bubble').remove();
}

// ─── 입력 잠금 ────────────────────────────────────────────────────────────────
// AI 응답 대기 중 중복 요청을 막기 위해 입력창과 전송 버튼 비활성화
function setInputLock(locked) {
    $('#chat-input').prop('disabled', locked);
    $('#send-btn').prop('disabled', locked);
    if (!locked) $('#chat-input').focus(); // 응답 완료 후 입력창에 자동 포커스
}

// ─── 메시지 전송 ──────────────────────────────────────────────────────────────
// 사용자 입력을 서버로 전송하고 AI 응답을 채팅 박스에 표시
async function sendMessage() {
    const text = $('#chat-input').val().trim();
    if (text === '') return;

    addMessage(text, 'user');
    $('#chat-input').val('');
    setInputLock(true);
    showTyping();

    try {
        // 현재 모드에 따라 일반 채팅 또는 RAG 채팅 엔드포인트로 요청
        const response = await fetch(ragMode ? '/api/rag/chat' : '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });
        const data = await response.json();
        hideTyping();

        if (data.error) {
            addMessage('오류: ' + data.error, 'ai');
        } else {
            addMessage(data.reply, 'ai');
            // RAG 모드일 때 답변에 사용된 출처 파일명 표시
            if (ragMode && data.sources && data.sources.length > 0) {
                const sourceNames = data.sources.map(s => s.split('/').pop()).join(', ');
                addMessage('출처: ' + sourceNames, 'source');
            }
        }
    } catch (err) {
        hideTyping();
        addMessage('오류가 발생했습니다.', 'ai');
    } finally {
        setInputLock(false);
    }
}

// ─── RAG 상태 조회 ────────────────────────────────────────────────────────────
// 업로드된 문서 수와 총 청크 수를 서버에서 가져와 RAG 패널에 표시
function loadRagStatus() {
    $.ajax({
        url: '/api/rag/status',
        method: 'GET',
        success: function(data) {
            $('#stat-docs').text((data.total_documents ?? '-') + '개');
            $('#stat-chunks').text((data.total_chunks ?? '-') + '개');
        },
        error: function() {
            $('#stat-docs').text('-');
            $('#stat-chunks').text('-');
        }
    });
}

// ─── 문서 목록 렌더링 ─────────────────────────────────────────────────────────
// 서버에서 받은 파일명 배열을 모달 안에 목록으로 그리고 각 항목에 삭제 버튼 추가
function renderDocuments(docs) {
    const list = $('#doc-modal-list');
    list.empty();
    if (!docs || docs.length === 0) {
        list.append('<div class="doc-empty">업로드된 문서가 없습니다.</div>');
        return;
    }
    docs.forEach(function(name) {
        const item = $('<div class="doc-item">');
        const nameSpan = $('<span class="doc-item-name">').text(name);
        const deleteBtn = $('<button class="doc-delete-btn">').text('✕');
        deleteBtn.on('click', function() {
            deleteDocument(name);
        });
        item.append(nameSpan).append(deleteBtn);
        list.append(item);
    });
}

// 서버에서 문서 목록을 가져와 모달에 렌더링
function loadDocuments() {
    $.ajax({
        url: '/api/rag/documents',
        method: 'GET',
        success: function(data) {
            renderDocuments(data.documents);
        }
    });
}

// 특정 문서를 서버(파일 + ChromaDB 청크)에서 삭제하고 목록 갱신
function deleteDocument(filename) {
    $.ajax({
        url: '/api/rag/documents/' + encodeURIComponent(filename),
        method: 'DELETE',
        success: function() {
            loadDocuments();   // 모달 목록 갱신
            loadRagStatus();   // 문서 수 / 청크 수 갱신
        },
        error: function() {
            alert('삭제에 실패했습니다.');
        }
    });
}

// ─── 문서 목록 모달 ───────────────────────────────────────────────────────────
function openDocModal() {
    loadDocuments();
    $('#doc-modal-overlay').addClass('visible');
}

function closeDocModal() {
    $('#doc-modal-overlay').removeClass('visible');
}

$('#doc-list-btn').on('click', openDocModal);
$('#doc-modal-close').on('click', closeDocModal);
// 모달 바깥 영역 클릭 시 닫기
$('#doc-modal-overlay').on('click', function(e) {
    if (e.target === this) closeDocModal();
});

// ─── 모드 토글 ────────────────────────────────────────────────────────────────
// 일반 모드 버튼: RAG 패널 숨기고 일반 채팅 이력 복원
$('#btn-normal').on('click', function() {
    if (!ragMode) return;
    ragMode = false;
    $('#btn-normal').addClass('active');
    $('#btn-rag').removeClass('active');
    $('#rag-panel').removeClass('visible');
    $('#header-title').text('AI 채팅');
    renderHistory(history.normal);
});

// RAG 모드 버튼: RAG 패널 표시하고 RAG 채팅 이력 복원 + 상태 갱신
$('#btn-rag').on('click', function() {
    if (ragMode) return;
    ragMode = true;
    $('#btn-rag').addClass('active');
    $('#btn-normal').removeClass('active');
    $('#rag-panel').addClass('visible');
    $('#header-title').text('AI 채팅 (RAG)');
    renderHistory(history.rag);
    loadRagStatus();
});

// ─── 파일 업로드 ──────────────────────────────────────────────────────────────
let uploadCancelled = false;
let currentXhr = null;

// XHR로 파일 1개를 업로드하면서 두 가지 진행 정보를 콜백으로 전달:
//   { type: 'upload', pct }  → 파일 전송 % (브라우저 → Node.js)
//   { type: 'stage', data }  → FastAPI SSE 진행 이벤트 (chunking/embedding 등)
function uploadFile(file, onUpdate) {
    return new Promise((resolve) => {
        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        currentXhr = xhr;

        let lastLen = 0;
        let buf = '';
        let lastResult = null;

        // 파일 전송 진행률 (브라우저 → Node.js 서버)
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onUpdate({ type: 'upload', pct: Math.round(e.loaded / e.total * 100) });
            }
        };

        // 응답 본문에서 SSE 이벤트를 점진적으로 읽어 onUpdate 콜백으로 전달
        xhr.onreadystatechange = () => {
            if (xhr.readyState >= 3 && xhr.responseText.length > lastLen) {
                buf += xhr.responseText.slice(lastLen);
                lastLen = xhr.responseText.length;

                const lines = buf.split('\n');
                buf = lines.pop(); // 아직 완성되지 않은 마지막 줄은 버퍼에 보관

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.error) lastResult = { ok: false, error: data.error };
                        else if (data.stage === 'done') lastResult = { ok: true, ...data };
                        onUpdate({ type: 'stage', data });
                    } catch (_) {}
                }
            }
            if (xhr.readyState === 4) {
                // 버퍼에 남아있는 미처리 줄이 있으면 마지막으로 처리
                if (buf.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(buf.slice(6).trim());
                        if (data.error) lastResult = { ok: false, error: data.error };
                        else if (data.stage === 'done') lastResult = { ok: true, ...data };
                    } catch (_) {}
                }
                currentXhr = null;
                resolve(lastResult || { ok: false, error: '서버 응답 없음' });
            }
        };

        xhr.onerror = () => { currentXhr = null; resolve({ ok: false, error: '네트워크 오류' }); };
        xhr.onabort = () => { currentXhr = null; resolve({ ok: false, aborted: true }); };

        xhr.open('POST', '/api/rag/upload');
        xhr.send(formData);
    });
}

// 중단 버튼 클릭 시 현재 XHR을 즉시 중단하고 루프 탈출 유도
$('#upload-cancel-btn').on('click', function() {
    uploadCancelled = true;
    if (currentXhr) currentXhr.abort();
});

// 선택한 파일 여러 개를 순차 업로드하고 단계별 진행 상황을 실시간 표시
$('#file-input').on('change', async function() {
    const files = Array.from(this.files);
    if (files.length === 0) return;

    uploadCancelled = false;

    $('#file-input').prop('disabled', true);
    $('#upload-label').addClass('disabled');
    $('#upload-cancel-btn').show();
    $(this).val('');

    const total = files.length;
    let succeeded = 0;
    let stopReason = null;
    let failedIndex = -1;

    for (let i = 0; i < files.length; i++) {
        if (uploadCancelled) { stopReason = 'cancel'; break; }

        const file = files[i];
        const seq = total > 1 ? ` (${i + 1}/${total})` : '';

        const result = await uploadFile(file, ({ type, pct, data }) => {
            if (type === 'upload') {
                $('#upload-msg')
                    .text(`파일 전송 중... ${file.name}${seq} ${pct}%`)
                    .removeClass('error').addClass('uploading');
            } else if (type === 'stage') {
                const s = data?.stage;
                if (s === 'chunking') {
                    $('#upload-msg').text(`청크 분할 중... ${file.name}${seq}`);
                } else if (s === 'chunked') {
                    $('#upload-msg').text(`청크 분할 완료 — ${data.count}개${seq}`);
                } else if (s === 'imaging') {
                    $('#upload-msg').text(`이미지 분석 중... ${file.name}${seq}`);
                } else if (s === 'imaged') {
                    $('#upload-msg').text(`이미지 분석 완료 — ${data.count}개${seq}`);
                } else if (s === 'embedding') {
                    // 임베딩 배치 진행률
                    const pct = Math.round(data.done / data.total * 100);
                    $('#upload-msg').text(`임베딩 중... ${data.done}/${data.total}개 (${pct}%)${seq}`);
                } else if (data?.error) {
                    $('#upload-msg').text(`✗ ${data.error}`).addClass('error').removeClass('uploading');
                }
            }
        });

        if (result.aborted) { stopReason = 'cancel'; break; }
        if (!result.ok) { stopReason = 'error:' + (result.error || '알 수 없는 오류'); failedIndex = i; break; }

        succeeded++;

        // 파일 1개 완료 — 청크 수와 이미지 수 표시
        const parts = [];
        if (result.chunks > 0) parts.push(`텍스트 ${result.chunks}개 청크`);
        if (result.images > 0) parts.push(`이미지 ${result.images}개`);
        const info = parts.join(', ') || '처리 완료';
        $('#upload-msg')
            .text(`✓ ${file.name} — ${info}${seq}`)
            .removeClass('uploading error');
    }

    loadRagStatus();

    if (stopReason === 'cancel') {
        $('#upload-msg')
            .text(`⊘ 업로드 중단됨 (${succeeded}/${total}개 완료)`)
            .removeClass('uploading').addClass('error');
    } else if (stopReason?.startsWith('error:')) {
        $('#upload-msg')
            .text(`✗ ${files[failedIndex].name} 실패: ${stopReason.slice(6)}`)
            .removeClass('uploading').addClass('error');
    } else if (total > 1) {
        // 여러 파일이면 최종 요약 (단일 파일은 개별 완료 메시지 유지)
        $('#upload-msg').text(`✓ ${total}개 파일 모두 완료`).removeClass('uploading error');
    }

    $('#file-input').prop('disabled', false);
    $('#upload-label').removeClass('disabled');
    $('#upload-cancel-btn').hide();
});

// ─── 이벤트 바인딩 ────────────────────────────────────────────────────────────
$('#send-btn').on('click', sendMessage);
$('#chat-input').on('keydown', function(e) {
    if (e.key === 'Enter') sendMessage(); // Enter 키로 메시지 전송
});
