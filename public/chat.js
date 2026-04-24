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
// 선택한 파일 여러 개를 순차적으로 서버에 업로드하고 진행 상황을 실시간 표시
$('#file-input').on('change', async function() {
    const files = Array.from(this.files);
    if (files.length === 0) return;

    // 업로드 중 중복 선택 방지
    $('#file-input').prop('disabled', true);
    $('#upload-label').addClass('disabled');
    $(this).val(''); // 같은 파일을 다시 선택할 수 있도록 input 초기화

    const total = files.length;
    let succeeded = 0;
    let failed = 0;

    for (const file of files) {
        // 현재 업로드 중인 파일명과 진행 순서 표시
        $('#upload-msg').text(`업로드 중... ${file.name} (${succeeded + failed + 1}/${total})`).removeClass('error').addClass('uploading');

        const formData = new FormData();
        formData.append('file', file);

        // Promise로 감싸 $.ajax의 비동기를 await로 기다림 (순차 업로드 보장)
        await new Promise(function(resolve) {
            $.ajax({
                url: '/api/rag/upload',
                method: 'POST',
                data: formData,
                processData: false, // FormData를 문자열로 변환하지 않음
                contentType: false, // jQuery가 Content-Type을 덮어쓰지 않도록
                success: function() { succeeded++; },
                error: function() { failed++; },
                complete: resolve, // 성공/실패 무관하게 다음 파일로 진행
            });
        });
    }

    loadRagStatus(); // 전체 업로드 완료 후 문서 수 / 청크 수 갱신

    // 결과 메시지 표시
    if (failed === 0) {
        $('#upload-msg').text(`✓ ${total}개 파일 업로드 완료`).removeClass('uploading error');
    } else {
        $('#upload-msg').text(`✓ ${succeeded}개 완료 / ✗ ${failed}개 실패`).removeClass('uploading').addClass('error');
    }

    $('#file-input').prop('disabled', false);
    $('#upload-label').removeClass('disabled');
});

// ─── 이벤트 바인딩 ────────────────────────────────────────────────────────────
$('#send-btn').on('click', sendMessage);
$('#chat-input').on('keydown', function(e) {
    if (e.key === 'Enter') sendMessage(); // Enter 키로 메시지 전송
});
