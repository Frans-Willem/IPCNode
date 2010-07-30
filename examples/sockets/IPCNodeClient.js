var sys=require("sys");
var net=require("net");
var IPCNode=require("../../IPCNode").IPCNode;

var isDebug=true;

var client=net.createConnection(81234);
var ipc=new IPCNode();
client.on("connect",function() {
	if (!isDebug) {
		sys.pump(client,ipc,function() { ipc.end(); sys.puts("Connection closed"); });
		sys.pump(ipc,client,function() { client.end(); client.destroy() });
	} else {
		client.on("data",function(data) {
			data.toString().split("\n").forEach(function(line) {
				if (line.length<1)
					return;
				sys.puts(">> "+line);
			});
			ipc.write(data);
		});
		ipc.on("data",function(data) {
			data.toString().split("\n").forEach(function(line) {
				if (line.length<1)
					return;
				sys.puts("<< "+line);
			});
			client.write(data);
		});
	}
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
ipc.on("clean",function() {
	sys.puts("IPC channel clean");
});