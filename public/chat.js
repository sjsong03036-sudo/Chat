// $() → jQuery 선택자. CSS 선택자 문법 그대로 사용
// $('#id'), $('.class'), $('태그')

function addMessage(text, role) {
    const msg = $('<div>');              // 새 <div> 요소 생성
    msg.addClass('message ' + role);    // 클래스 추가
    msg.text(text);                     // 텍스트 삽입 (.innerText 대신)
    $('#chat-box').append(msg);         // chat-box 안에 추가 (.appendChild 대신)

    // 스크롤 맨 아래로
    // [0] → jQuery 객체를 일반 DOM 요소로 꺼냄 (scrollHeight는 순수 JS 속성)
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

// function getAIResponse(userText) {
//     return '(AI 응답 준비 중) "' + userText + '"';
// }

function sendMessage() {
    const text = $('#chat-input').val().trim();  // .value 대신 .val()
    if (text === '') return;

    addMessage(text, 'user');
    $('#chat-input').val('');           // 입력창 비우기

    // $.ajax → fetch() 대신 jQuery가 제공하는 HTTP 요청 함수
    $.ajax({
        url: '/api/chat',              // 요청 보낼 주소
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ message: text }),  // 요청 본문 (JSON 문자열로 변환)
        success: function(data) {      // 응답 성공 시 실행 (fetch의 .then() 대신)
            addMessage(data.reply, 'ai');
        },
        error: function() {            // 요청 실패 시 실행 (fetch의 .catch() 대신)
            addMessage('오류가 발생했습니다.', 'ai');
        }
    });
}

// .on('이벤트', 함수) → addEventListener 대신
$('#send-btn').on('click', sendMessage);

$('#chat-input').on('keydown', function (e) {
    if (e.key === 'Enter') sendMessage();
});
