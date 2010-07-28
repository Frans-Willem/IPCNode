var sys=require("sys");
var net=require("net");
var IPCNode=require("../../IPCNode").IPCNode;

var client=net.createConnection(81234);
var ipc=new IPCNode();
client.on("connect",function() {
	sys.pump(client,ipc,function() { ipc.end(); sys.puts("Connection closed"); });
	sys.pump(ipc,client,function() { client.end(); client.destroy() });
});
client.on("error",function(e) {
	sys.puts("Client error: "+e.toString());
	ipc.end();
});
ipc.on("error",function(e) {
	sys.puts("IPC error: "+e.toString());
	client.end();
});
ipc.on("register",function(name,obj) {
	sys.puts("Got object: "+name);
	if (name=="main") {
		//obj will be disposed once this method ends, so we need a copy for in the callback functions
		var copy=IPCNode.reference(obj);
		copy.increase();
		copy.get_counter(function(i) {
			copy.printString("Client number: "+i);
			copy.printArray(["Hello","World"]);
			copy.printSimpleObject({Hello: "World",How: "Are", You: "Today"});
			//No longer using copy, so dispose it.
			IPCNode.dispose(copy);
		});
	}
});