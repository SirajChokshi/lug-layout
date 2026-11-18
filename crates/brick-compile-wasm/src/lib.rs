mod frame;
mod reply;
mod request;
mod session;
mod tracking;

use std::cell::RefCell;

use session::Session;

thread_local! {
    static REQUEST: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static SESSION: RefCell<Session> = RefCell::new(Session::default());
}

#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn brr_request(length: usize) -> usize {
    REQUEST.with_borrow_mut(|request| {
        request.clear();
        request.resize(length, 0);
        request.as_mut_ptr() as usize
    })
}

#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn brr_call() -> usize {
    let response =
        REQUEST.with_borrow(|request| SESSION.with_borrow_mut(|session| session.handle(request)));
    RESPONSE.with_borrow_mut(|stored| {
        *stored = response;
        stored.len()
    })
}

#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn brr_response() -> usize {
    RESPONSE.with_borrow(|response| response.as_ptr() as usize)
}
