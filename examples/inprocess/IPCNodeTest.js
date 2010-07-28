var IPCNode=require("../../IPCNode").IPCNode;
var sys=require("sys");

var a=new IPCNode();
var b=new IPCNode();

sys.pump(a,b);
sys.pump(b,a);

var ipcobj={
	msg: "",
	set: function(s) { this.msg=s; },
	get: IPCNode.sync(function() {
		return this.msg;
	}),
	timerAsync: IPCNode.async(function(callback) {
		setTimeout(function() { callback(); },1000);
	}),
	timerCustom: function(callback) {
		var callbackRef=IPCNode.reference(callback);
		setTimeout(function() {
			callbackRef();
			IPCNode.dispose(callbackRef);
		},1000);
	}
};

function demonstrate(obj,method) {
	obj.set("Hello world");
	obj.get(function(msg) {
		sys.puts("Got message over "+method+": '"+msg+"'");
	});
	obj.timerAsync(function() {
		sys.puts("timerAsync callback over "+method);
	});
	obj.timerCustom(function() {
		sys.puts("timerCustom callback over "+method);
	});
}

b.on("register",function(name,obj) {
	if (name=="ipc")
		demonstrate(obj,"IPC");
});

sys.puts("Demonstrating directly");
demonstrate(ipcobj,"local");
sys.puts("Demonstrating over IPCNode");
a.register("ipc",ipcobj);
a.on("clean",function() {
	sys.puts("Server endpoint clean");
});
b.on("clean",function() {
	sys.puts("Client endpoint clean");
});