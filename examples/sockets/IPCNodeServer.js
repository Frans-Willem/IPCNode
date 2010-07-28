var net=require("net");
var sys=require("sys");
var IPCNode=require("../../IPCNode").IPCNode;

//Main object being made available to the clients
var mainObject={
	counter: 0,
	increase: function() {
		this.counter++;
	},
	get_counter: IPCNode.sync(function() {
		return this.counter;
	}),
	printString: function(msg) {
		sys.puts("String: "+msg);
	},
	printArray: function(msgs) {
		sys.puts("Array:");
		for (var i=0; i<msgs.length; i++)
			sys.puts("\t"+msgs[i]);
	},
	printSimpleObject: function(msgs) {
		sys.puts("Object:");
		for (var i in msgs)
			sys.puts("\t"+i+": "+msgs[i]);
	}
};

net.createServer(function(client) {
	sys.puts("New connection");
	client.on("connect",function() {
		sys.puts("Connected");
		var ipc=new IPCNode();
		sys.pump(ipc,client,function() { ipc.end(); });
		sys.pump(client,ipc,function() { client.end(); client.destroy(); });
		
		ipc.on("error",function(e) {
			sys.puts("IPC error: "+e.toString());
			client.end();
			client.destroy();
		});
		ipc.on("clean",function(from) {
			sys.puts("IPC stream is clean, no more cross-process oject references");
			ipc.end();
			client.end();
			client.destroy();
		});
		
		ipc.register("main",mainObject);
	});
	client.on("error",function(e) {
		sys.puts("Client error: "+e.toString());
		ipc.end();
	});
}).listen(81234);
sys.puts("Listening on port 81234");